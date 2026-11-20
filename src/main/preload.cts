import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi } from '../shared/types.js';

let closeGuard: (() => Promise<boolean>) | null = null;
ipcRenderer.on('worktrees:requestClose', async () => {
  try {
    const approved = closeGuard ? await closeGuard() : true;
    ipcRenderer.send('worktrees:closeDecision', approved);
  } catch {
    ipcRenderer.send('worktrees:closeDecision', false);
  }
});

const api: AppApi = {
  onCloseRequested: (approve) => {
    closeGuard = approve;
    return () => { if (closeGuard === approve) closeGuard = null; };
  },
  getSnapshot: () => ipcRenderer.invoke('worktrees:getSnapshot'),
  chooseDirectory: () => ipcRenderer.invoke('worktrees:chooseDirectory'),
  addRepository: (path) => ipcRenderer.invoke('worktrees:addRepository', path),
  removeRepository: (id) => ipcRenderer.invoke('worktrees:removeRepository', id),
  updateRepository: (id, patch) => ipcRenderer.invoke('worktrees:updateRepository', id, patch),
  updateSettings: (patch) => ipcRenderer.invoke('worktrees:updateSettings', patch),
  listBranches: (id) => ipcRenderer.invoke('worktrees:listBranches', id),
  previewCreate: (input) => ipcRenderer.invoke('worktrees:previewCreate', input),
  createWorktree: (input) => ipcRenderer.invoke('worktrees:createWorktree', input),
  previewRecovery: (id) => ipcRenderer.invoke('worktrees:previewRecovery', id),
  recreateWorktree: (id) => ipcRenderer.invoke('worktrees:recreateWorktree', id),
  previewDelete: (id, deleteBranch) => ipcRenderer.invoke('worktrees:previewDelete', id, deleteBranch),
  deleteWorktree: (input) => ipcRenderer.invoke('worktrees:deleteWorktree', input),
  revealPath: (path) => ipcRenderer.invoke('worktrees:revealPath', path),
  copyText: (text) => ipcRenderer.invoke('worktrees:copyText', text),
};
contextBridge.exposeInMainWorld('worktrees', Object.freeze(api));
