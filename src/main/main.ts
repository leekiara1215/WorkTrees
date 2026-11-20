import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppError, CreateInput, Result, Worktree } from '../shared/types.js';
import { createWorktreeService } from './worktree-service.js';

const developmentUrl = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
app.setName('WorkTrees Lite');
// An isolated local profile is useful for integration/UI checks.
const profileOverride = process.env.WORKTREES_LITE_DATA_DIR;
if (profileOverride && isAbsolute(profileOverride)) app.setPath('userData', profileOverride);
const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

function toError(error: unknown): AppError {
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { message: unknown; code?: unknown; details?: unknown; retryable?: unknown };
    return { code: typeof e.code === 'string' ? e.code : 'INTERNAL_ERROR', message: String(e.message), ...(typeof e.details === 'string' ? { details: e.details } : {}), ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}) };
  }
  return { code: 'INTERNAL_ERROR', message: '操作失败，请重试。' };
}
function validSender(url: string): boolean {
  if (developmentUrl) return url === developmentUrl || url.startsWith(`${developmentUrl}/`);
  return url === new URL('../../dist/index.html', import.meta.url).href;
}
function handle(name: string, fn: (...args: unknown[]) => unknown) {
  ipcMain.handle(`worktrees:${name}`, async (event, ...args): Promise<Result<unknown>> => {
    if (event.sender !== mainWindow?.webContents || !event.senderFrame || !validSender(event.senderFrame.url)) return { ok: false, error: { code: 'UNTRUSTED_WINDOW', message: '无法从此窗口执行操作。' } };
    try { return { ok: true, data: await fn(...args) }; } catch (error) { return { ok: false, error: toError(error) }; }
  });
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768) throw Object.assign(new Error(`${label}无效。`), { code: 'INVALID_INPUT' });
  return value;
}
async function createWindow() {
  const window = new BrowserWindow({ width: 1320, height: 860, minWidth: 940, minHeight: 620, title: 'WorkTrees Lite', backgroundColor: '#f6f7f9', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 }, webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  mainWindow = window;
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!validSender(url)) event.preventDefault(); });

  let closeIntent: 'window' | 'app' | null = null;
  let closeApproved = false;
  function requestClose(event: { preventDefault(): void }, intent: 'window' | 'app') {
    if (closeApproved || contents.isCrashed() || contents.isLoadingMainFrame() || !validSender(contents.getURL())) return;
    event.preventDefault();
    if (closeIntent) {
      if (intent === 'app') closeIntent = intent;
      return;
    }
    closeIntent = intent;
    contents.send('worktrees:requestClose');
  }
  function finishClose(approved: boolean) {
    const intent = closeIntent;
    closeIntent = null;
    if (!intent || !approved) return;
    closeApproved = true;
    if (intent === 'app') app.quit();
    else window.close();
  }
  const beforeQuit = (event: { preventDefault(): void }) => requestClose(event, 'app');
  app.on('before-quit', beforeQuit);
  window.on('close', event => requestClose(event, 'window'));
  contents.ipc.on('worktrees:closeDecision', (event, approved: unknown) => {
    if (event.senderFrame === contents.mainFrame && validSender(event.senderFrame.url)) finishClose(approved === true);
  });
  contents.on('did-start-loading', () => { closeIntent = null; });
  contents.on('render-process-gone', () => finishClose(true));
  window.on('closed', () => {
    app.off('before-quit', beforeQuit);
    if (mainWindow === window) mainWindow = null;
  });
  if (developmentUrl) await window.loadURL(developmentUrl); else await window.loadFile(fileURLToPath(new URL('../../dist/index.html', import.meta.url)));
}

if (instanceLock) app.whenReady().then(async () => {
  const service = createWorktreeService({ dataDir: app.getPath('userData') });
  const backupPaths = new Set<string>();
  const checkouts = new Map<string, AbortController>();
  async function runCheckout(taskId: unknown, operation: (signal: AbortSignal) => Promise<Worktree>) {
    if (typeof taskId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(taskId) || checkouts.has(taskId)) {
      throw Object.assign(new Error('检出任务编号无效或已在运行。'), { code: 'INVALID_INPUT' });
    }
    const controller = new AbortController();
    const contents = mainWindow!.webContents;
    const stop = () => controller.abort();
    checkouts.set(taskId, controller);
    contents.once('destroyed', stop);
    contents.once('render-process-gone', stop);
    contents.once('did-start-loading', stop);
    try {
      return await operation(controller.signal);
    } finally {
      checkouts.delete(taskId);
      contents.off('destroyed', stop);
      contents.off('render-process-gone', stop);
      contents.off('did-start-loading', stop);
    }
  }
  handle('createWorktree', (input, taskId) => runCheckout(taskId, signal => service.createWorktree(input as CreateInput, signal)));
  handle('recreateWorktree', (id, taskId) => runCheckout(taskId, signal => service.recreateWorktree(id as string, signal)));
  // Cancellation must not wait behind the serial checkout it is stopping.
  handle('cancelCheckout', taskId => {
    if (typeof taskId === 'string') checkouts.get(taskId)?.abort();
  });
  // Service validates every argument, including calls from untyped IPC boundaries.
  const methods = ['getSnapshot', 'addRepository', 'removeRepository', 'updateRepository', 'updateSettings', 'listBranches', 'previewCreate', 'previewRecovery', 'removeWorktreeRecord', 'previewDelete', 'deleteWorktree'] as const;
  for (const method of methods) handle(method, async (...args) => {
    const result = await Reflect.apply(service[method], service, args);
    if (method === 'deleteWorktree') for (const module of result.submodules) if (module.backupPath) backupPaths.add(module.backupPath);
    return result;
  });
  handle('chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('copyText', (value) => { if (typeof value !== 'string' || value.length > 65536) throw Object.assign(new Error('复制内容无效。'), { code: 'INVALID_INPUT' }); clipboard.writeText(value); });
  handle('revealPath', async (value) => {
    const path = requiredString(value, '路径');
    if (!isAbsolute(path)) throw Object.assign(new Error('请选择绝对路径。'), { code: 'INVALID_INPUT' });
    const snapshot = await service.getSnapshot();
    if (!backupPaths.has(path) && ![...snapshot.repositories.map(repo => repo.path), ...snapshot.worktrees.map(tree => tree.path)].includes(path)) throw Object.assign(new Error('此路径不属于已登记的仓库、工作树或本次生成的子模块备份。'), { code: 'UNKNOWN_PATH' });
    shell.showItemInFolder(path);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(developmentUrl ? [{ role: 'toggleDevTools' as const }] : [])] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ]));
  await createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch(error => { dialog.showErrorBox('WorkTrees Lite 无法启动', toError(error).message); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
