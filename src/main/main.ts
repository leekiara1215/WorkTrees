import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppError, Result } from '../shared/types.js';
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!validSender(url)) event.preventDefault(); });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  if (developmentUrl) await window.loadURL(developmentUrl); else await window.loadFile(fileURLToPath(new URL('../../dist/index.html', import.meta.url)));
}

if (instanceLock) app.whenReady().then(async () => {
  const service = createWorktreeService({ dataDir: app.getPath('userData') });
  // Service validates every argument, including calls from untyped IPC boundaries.
  const methods = ['getSnapshot', 'addRepository', 'removeRepository', 'updateRepository', 'updateSettings', 'listBranches', 'previewCreate', 'createWorktree', 'previewRecovery', 'recreateWorktree'] as const;
  for (const method of methods) handle(method, (...args) => Reflect.apply(service[method], service, args));
  handle('chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('copyText', (value) => { if (typeof value !== 'string' || value.length > 65536) throw Object.assign(new Error('复制内容无效。'), { code: 'INVALID_INPUT' }); clipboard.writeText(value); });
  handle('revealPath', async (value) => {
    const path = requiredString(value, '路径');
    if (!isAbsolute(path)) throw Object.assign(new Error('请选择绝对路径。'), { code: 'INVALID_INPUT' });
    const snapshot = await service.getSnapshot();
    if (![...snapshot.repositories.map(repo => repo.path), ...snapshot.worktrees.map(tree => tree.path)].includes(path)) throw Object.assign(new Error('此路径不属于已登记的仓库或工作树。'), { code: 'UNKNOWN_PATH' });
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
