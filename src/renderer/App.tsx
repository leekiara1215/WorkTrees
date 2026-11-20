import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_THEME_COLOR, type ThemeColor } from '../shared/theme-colors';
import type { AppError, DeleteOutcome, Repository, Snapshot, Worktree } from '../shared/types';
import { CreateDialog, DeleteDialog, RecoveryDialog, RemoveRecordDialog } from './dialogs';
import { SettingsDialog } from './SettingsDialog';
import { appError, ErrorNotice, Icon, request, Spinner } from './ui';

type Filter = 'all' | 'stale' | 'missing' | 'locked' | 'error';
type Dialog = { kind: 'create' } | { kind: 'settings' } | { kind: 'recovery'; worktree: Worktree } | { kind: 'delete'; worktree: Worktree } | null;
const filters: { id: Filter; label: string }[] = [{ id: 'all', label: '全部' }, { id: 'stale', label: '闲置' }, { id: 'missing', label: '缺失' }, { id: 'locked', label: '锁定' }, { id: 'error', label: '异常' }];
function matchesStatus(worktree: Worktree, status: Filter) {
  return status === 'all' || (status === 'stale' && worktree.stale) || (status === 'missing' && !worktree.exists) || (status === 'locked' && worktree.locked) || (status === 'error' && (!!worktree.error || worktree.prunable));
}
function formatDate(value: string | null) {
  if (!value) return '暂无活动记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无活动记录';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function folderName(path: string) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [preferredTheme, setThemeColor] = useState<ThemeColor | null>(null);
  const themeColor = preferredTheme ?? DEFAULT_THEME_COLOR;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [deleteWarnings, setDeleteWarnings] = useState<{ path: string; messages: string[]; submodules: DeleteOutcome['submodules'] } | null>(null);
  const [repoId, setRepoId] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [importing, setImporting] = useState(false);
  const [pathAction, setPathAction] = useState('');
  const [toast, setToast] = useState('');
  const loadSequence = useRef(0);
  const importBusy = useRef(false);
  const pathBusy = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError(null);
    try {
      const data = await request(() => window.worktrees.getSnapshot());
      if (sequence !== loadSequence.current || !mounted.current) return;
      setSnapshot(data);
      setThemeColor(current => current ?? data.settings.themeColor);
      setRepoId(current => data.repositories.some(repository => repository.id === current) ? current : '');
    } catch (error) { if (sequence === loadSequence.current && mounted.current) setLoadError(appError(error)); }
    finally { if (sequence === loadSequence.current && mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; ++loadSequence.current; }; }, [refresh]);
  useLayoutEffect(() => { document.documentElement.dataset.theme = themeColor; }, [themeColor]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !dialog) { event.preventDefault(); searchInput.current?.focus(); } };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [dialog]);

  async function importRepository() {
    if (importBusy.current) return;
    importBusy.current = true; setImporting(true); setActionError(null);
    try {
      const path = await request(() => window.worktrees.chooseDirectory());
      if (!path) return;
      const repository = await request(() => window.worktrees.addRepository(path));
      setRepoId(repository.id); setFilter('all'); setSearch(''); setToast(`已导入 ${repository.name}`);
      await refresh();
    } catch (error) { setActionError(appError(error)); }
    finally { importBusy.current = false; setImporting(false); }
  }
  async function actOnPath(worktree: Pick<Worktree, 'id' | 'path'>, action: 'copy' | 'reveal') {
    if (pathBusy.current) return;
    pathBusy.current = true; setPathAction(`${worktree.id}:${action}`); setActionError(null);
    try {
      await request(() => action === 'copy' ? window.worktrees.copyText(worktree.path) : window.worktrees.revealPath(worktree.path));
      if (action === 'copy') setToast('已复制完整路径');
    } catch (error) { setActionError(appError(error)); }
    finally { pathBusy.current = false; setPathAction(''); }
  }
  function completed(worktree: Worktree, recovering = false) {
    setDialog(null); setToast(`${recovering ? '已重建' : '已创建'} ${worktree.branch || folderName(worktree.path)}`); setRepoId(worktree.repoId); setSearch(''); setFilter('all'); void refresh();
  }

  function deleted(outcome: DeleteOutcome) {
    setDialog(null); setActionError(null);
    setDeleteWarnings(outcome.warnings.length || outcome.submodules.length ? { path: outcome.path, messages: outcome.warnings, submodules: outcome.submodules } : null);
    setToast(outcome.warnings.length ? '目录已删除，请查看后续处理提示' : outcome.branchDeleted ? '工作目录与本地分支已删除' : '工作目录已删除');
    void refresh();
  }
  function closeWorktreeDialog() {
    setDialog(null);
    void refresh();
  }
  function removedRecord() {
    setActionError(null);
    setToast('已移除应用记录');
    closeWorktreeDialog();
  }

  const repositories = snapshot?.repositories ?? [];
  const worktrees = snapshot?.worktrees ?? [];
  const selectedRepo = repositories.find(repository => repository.id === repoId);
  const searched = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return worktrees.filter(worktree => (!repoId || worktree.repoId === repoId) && (!query || [worktree.repoName, worktree.branch, worktree.path, folderName(worktree.path)].some(value => value?.toLocaleLowerCase().includes(query))));
  }, [worktrees, repoId, search]);
  const counts = Object.fromEntries(filters.map(item => [item.id, searched.filter(worktree => matchesStatus(worktree, item.id)).length])) as Record<Filter, number>;
  const visible = searched.filter(worktree => matchesStatus(worktree, filter));
  const grouped = useMemo(() => {
    const groups = new Map<string, { repository: Repository | undefined; name: string; worktrees: Worktree[] }>();
    for (const worktree of visible) {
      if (!groups.has(worktree.repoId)) groups.set(worktree.repoId, { repository: repositories.find(repo => repo.id === worktree.repoId), name: worktree.repoName, worktrees: [] });
      groups.get(worktree.repoId)!.worktrees.push(worktree);
    }
    return Array.from(groups, ([id, group]) => ({ id, ...group, worktrees: [...group.worktrees].sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.branch || a.path).localeCompare(b.branch || b.path)) }));
  }, [visible, repositories]);
  const hasFilters = !!search || !!repoId || filter !== 'all';

  return <>
    <div className="app-shell" inert={dialog !== null}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="branch" size={22} /></span><div><strong>WorkTrees</strong><span>LITE</span></div></div>
        <div className="sidebar-content"><div className="sidebar-section-label">工作空间</div><button type="button" className={`nav-item all-worktrees ${!repoId ? 'active' : ''}`} onClick={() => setRepoId('')}><Icon name="layers" /><span>全部 Worktree</span><span className="nav-count">{worktrees.length}</span></button><div className="sidebar-section-label repos-heading"><span>仓库</span><span>{repositories.length}</span></div><div className="repository-nav">{repositories.map(repo => <button type="button" className={`nav-item repo-nav-item ${repoId === repo.id ? 'active' : ''}`} key={repo.id} onClick={() => setRepoId(repo.id)} title={repo.path}><Icon name="folder" /><span className="repo-nav-name">{repo.name}</span><span className="nav-count">{worktrees.filter(item => item.repoId === repo.id).length}</span></button>)}{!repositories.length && <p className="sidebar-empty">添加本机 Git 仓库，<br />集中管理独立工作目录。</p>}</div><button type="button" className="import-button" onClick={() => void importRepository()} disabled={importing || loading}>{importing ? <Spinner label="正在导入" /> : <><Icon name="plus" size={16} />导入仓库</>}</button></div>
        <div className="sidebar-bottom"><div className="local-label"><span className="local-dot" />本机工作空间</div><button type="button" className="nav-item settings-link" onClick={() => setDialog({ kind: 'settings' })} disabled={!snapshot || importing}><Icon name="settings" /><span>偏好设置</span><Icon name="chevron" size={14} /></button></div>
      </aside>
      <main className="main-content">
        <header className="page-heading"><div><div className="breadcrumb"><span>工作空间</span><Icon name="chevron" size={12} /><span>{selectedRepo?.name ?? '全部仓库'}</span></div><div className="title-row"><h1>Worktrees</h1><span className="total-pill">{worktrees.length}</span></div><p className="page-subtitle">每个分支，一个专注的工作目录。</p></div><div className="heading-actions"><button type="button" className="button secondary refresh-button" onClick={() => void refresh()} disabled={loading || importing} title="重新读取仓库状态"><Icon name="refresh" size={16} className={loading ? 'rotating' : ''} /><span>{loading ? '刷新中' : '刷新'}</span></button><button type="button" className="button primary" onClick={() => setDialog({ kind: 'create' })} disabled={!repositories.length || loading || importing}><Icon name="plus" size={17} />创建 Worktree</button></div></header>
        <div className="content-scroll">
          {actionError && <div className="dismissible-error"><ErrorNotice error={actionError} /><button type="button" className="icon-button" onClick={() => setActionError(null)} aria-label="收起操作错误"><Icon name="close" size={16} /></button></div>}
          {deleteWarnings && <div className="delete-outcome-notice" role="status"><Icon name="alert" size={18} /><div><strong>{deleteWarnings.messages.length ? '工作目录已删除，仍有事项需要处理' : '工作目录已删除，子模块处理结果如下'}</strong><p className="path-value">{deleteWarnings.path}</p>{deleteWarnings.messages.length > 0 && <ul>{deleteWarnings.messages.map((message, index) => <li key={index}>{message}</li>)}</ul>}{deleteWarnings.submodules.length > 0 && <ul>{deleteWarnings.submodules.map(module => <li key={module.path}><span>{module.path}：{module.discarded ? '已选择不保留当前分支或游离提交' : module.backupPath ? '分支及提交已保留' : '未初始化，无本地 Git 数据'}{module.backupPath && module.discarded ? '；其他引用已备份' : ''}</span>{module.backupPath && <><p className="path-value">{module.backupPath}</p><div className="button-row"><button type="button" className="text-button" onClick={() => void actOnPath({ id: module.path, path: module.backupPath! }, 'reveal')} disabled={!!pathAction}>查看备份</button><button type="button" className="text-button" onClick={() => void actOnPath({ id: module.path, path: module.backupPath! }, 'copy')} disabled={!!pathAction}>复制备份路径</button></div></>}</li>)}</ul>}</div><button type="button" className="icon-button" onClick={() => setDeleteWarnings(null)} aria-label="收起删除结果提示"><Icon name="close" size={16} /></button></div>}
          <ErrorNotice error={loadError} onRetry={() => void refresh()} />
          {snapshot && snapshot.errors.length > 0 && <div className="snapshot-errors"><details><summary><Icon name="alert" size={16} /><span>{snapshot.errors.length} 项仓库读取异常</span><span className="muted">展开查看</span></summary><div>{snapshot.errors.map((error, index) => <ErrorNotice key={`${error.code}:${index}`} error={error} />)}</div></details></div>}
          <div className="list-toolbar"><div className="search-field"><Icon name="search" size={17} /><input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索分支、目录或仓库" placeholder="搜索分支、目录或仓库…" />{search ? <button type="button" className="icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><Icon name="close" size={14} /></button> : <kbd>⌘ K</kbd>}</div><label className="repository-filter"><Icon name="folder" size={16} /><select aria-label="筛选仓库" value={repoId} onChange={event => setRepoId(event.target.value)}><option value="">全部仓库</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label></div>
          <div className="status-toolbar"><div className="status-filters" role="group" aria-label="按状态筛选">{filters.map(item => <button type="button" key={item.id} className={`status-filter ${filter === item.id ? 'selected' : ''}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.id !== 'all' && <span className={`status-dot ${item.id}`} />}<span>{item.label}</span><span className="filter-count">{counts[item.id]}</span></button>)}</div><span className="results-label">{visible.length} 个目录</span></div>
          {loading && !snapshot ? <div className="empty-state"><Spinner label="正在读取工作空间" /></div> : !snapshot ? <div className="empty-state"><div className="empty-icon"><Icon name="alert" size={29} /></div><h2>暂时无法读取工作空间</h2><p>请检查桌面连接后重新读取。</p><button type="button" className="button secondary" onClick={() => void refresh()} disabled={loading}>重新读取</button></div> : !repositories.length ? <div className="empty-state welcome-state"><div className="empty-illustration"><span className="illustration-line" /><span className="illustration-node node-one"><Icon name="folder" size={27} /></span><span className="illustration-node node-two"><Icon name="branch" size={21} /></span><span className="illustration-node node-three"><Icon name="branch" size={21} /></span></div><p className="eyebrow">一个仓库，多种可能</p><h2>从导入第一个仓库开始</h2><p>为不同分支创建独立目录，<br />让每一份工作都井然有序。</p><button type="button" className="button primary" onClick={() => void importRepository()} disabled={importing}>{importing ? <Spinner label="正在导入" /> : <><Icon name="plus" size={17} />导入 Git 仓库</>}</button><span className="empty-note">选择本机已有的 Git 仓库目录</span></div> : !visible.length ? <div className="empty-state"><div className="empty-icon"><Icon name={hasFilters ? 'search' : 'branch'} size={29} /></div><h2>{hasFilters ? '没有符合条件的 Worktree' : '还没有可显示的工作目录'}</h2><p>{hasFilters ? '试试其他关键词、仓库或状态。' : '可以刷新仓库状态，或创建一个新的 Worktree。'}</p>{hasFilters ? <button type="button" className="button secondary" onClick={() => { setSearch(''); setRepoId(''); setFilter('all'); }}>清除筛选</button> : <button type="button" className="button primary" onClick={() => setDialog({ kind: 'create' })}>创建 Worktree</button>}</div> : <div className="worktree-groups" aria-busy={loading}>{grouped.map(group => <section className="worktree-group" key={group.id}><div className="group-heading"><div className="group-repository"><Icon name="folder" size={18} /><h2>{group.name}</h2><span className="group-count">{group.worktrees.length}</span></div><span className="group-path" title={group.repository?.path}>{group.repository?.path}</span></div><div className="worktree-list">{group.worktrees.map(worktree => <WorktreeCard key={worktree.id} worktree={worktree} pathAction={pathAction} onPathAction={action => void actOnPath(worktree, action)} onRecover={() => setDialog({ kind: 'recovery', worktree })} onDelete={() => setDialog({ kind: 'delete', worktree })} />)}</div></section>)}</div>}
          <footer className="workspace-footer"><span><span className={`local-dot ${loadError ? 'offline' : ''}`} />{loading ? '正在读取最新状态…' : snapshot ? `最后刷新 ${formatDate(snapshot.refreshedAt)}` : '等待连接'}</span><span>本地管理 · 数据仅保存在本机</span></footer>
        </div>
      </main>
    </div>
    {toast && <div className="toast" role="status"><Icon name="check" size={17} />{toast}<button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><Icon name="close" size={14} /></button></div>}
    {dialog?.kind === 'create' && snapshot && <CreateDialog repositories={repositories} settings={snapshot.settings} initialRepoId={repoId} onClose={closeWorktreeDialog} onCreated={completed} />}
    {dialog?.kind === 'settings' && snapshot && <SettingsDialog settings={snapshot.settings} themeColor={themeColor} onThemeChange={setThemeColor} repositories={repositories} onClose={changed => { setDialog(null); if (changed) void refresh(); }} onRepositoryRemoved={() => void refresh()} />}
    {dialog?.kind === 'delete' && (dialog.worktree.canRemoveRecord
      ? <RemoveRecordDialog worktree={dialog.worktree} onClose={closeWorktreeDialog} onRemoved={removedRecord} />
      : <DeleteDialog worktree={dialog.worktree} onClose={closeWorktreeDialog} onDeleted={deleted} />)}
    {dialog?.kind === 'recovery' && <RecoveryDialog worktree={dialog.worktree} onClose={closeWorktreeDialog} onRecovered={worktree => completed(worktree, true)} />}
  </>;
}

function WorktreeCard({ worktree, pathAction, onPathAction, onRecover, onDelete }: { worktree: Worktree; pathAction: string; onPathAction: (action: 'copy' | 'reveal') => void; onRecover: () => void; onDelete: () => void }) {
  const missing = !worktree.exists;
  const exceptional = !!worktree.error || worktree.prunable;
  const canRecover = missing && worktree.managed && !worktree.isMain;
  const deleteLabel = worktree.canRemoveRecord ? '移除记录' : '安全删除';
  return <article className={`worktree-card ${missing ? 'is-missing' : ''} ${exceptional ? 'is-exceptional' : ''}`}><div className={`worktree-symbol ${missing ? 'missing' : worktree.isMain ? 'main' : ''}`}><Icon name={missing ? 'alert' : worktree.isMain ? 'folder' : 'branch'} size={21} /></div><div className="worktree-info"><div className="worktree-title"><h3 title={worktree.branch || worktree.head || undefined}>{worktree.branch || (worktree.head ? `游离 HEAD · ${worktree.head.slice(0, 8)}` : folderName(worktree.path))}</h3>{worktree.isMain ? <span className="badge main">主仓库</span> : !worktree.managed ? <span className="badge external">外部目录</span> : null}{missing && <span className="badge missing">目录缺失</span>}{worktree.locked && <span className="badge locked" title={worktree.lockReason || '已锁定'}><Icon name="lock" size={11} />已锁定</span>}{worktree.stale && <span className="badge stale">闲置</span>}{exceptional && <span className="badge error">异常</span>}</div><div className="worktree-path"><span title={worktree.path}>{worktree.path}</span><button type="button" className="path-copy" onClick={() => onPathAction('copy')} aria-label={`复制 ${worktree.branch || folderName(worktree.path)} 的完整路径`} title="复制完整路径" disabled={!!pathAction}><Icon name="copy" size={13} /></button></div><div className="worktree-meta"><span><Icon name="clock" size={12} />{formatDate(worktree.lastActivityAt)}</span>{worktree.baseBranch && <span className="base-branch">基于 {worktree.baseBranch}</span>}{worktree.locked && worktree.lockReason && <span className="lock-reason" title={worktree.lockReason}>锁定原因：{worktree.lockReason}</span>}</div>{worktree.error && <div className="row-error"><Icon name="alert" size={13} /><span>{worktree.error.message}</span>{worktree.error.details && <details><summary>详情</summary><p>{worktree.error.details}</p></details>}</div>}{worktree.prunable && !worktree.error && <p className="row-hint">Git 记录标记为可清理，请检查原目录与仓库状态。</p>}{missing && !canRecover && <p className="row-hint">{worktree.isMain ? '主仓库目录缺失，请检查原路径或重新导入仓库。' : '此目录由外部工具创建，没有可用的重建记录。'}</p>}</div><div className="worktree-actions">{canRecover ? <button type="button" className="button recovery-button" onClick={onRecover} disabled={worktree.locked} title={worktree.locked ? '此 Worktree 已锁定，请先在仓库中检查锁定原因' : '预览并确认重建目录'}><Icon name="restore" size={15} />重建目录</button> : <button type="button" className="button open-button" onClick={() => onPathAction('reveal')} disabled={missing || !!pathAction} title={missing ? '目录不存在，无法打开' : '在文件管理器中显示'}>{pathAction === `${worktree.id}:reveal` ? <Spinner label="打开中" /> : <><Icon name="folder" size={15} />打开目录<Icon name="arrow" size={14} /></>}</button>}{!worktree.isMain && <button type="button" className="button delete-button" onClick={onDelete} disabled={worktree.locked || !!pathAction} title={worktree.locked ? `此 Worktree 已锁定，请先检查锁定原因${worktree.lockReason ? `：${worktree.lockReason}` : ''}` : worktree.canRemoveRecord ? '移除应用中的残留记录' : '检查修改与提交，确认后删除 Worktree'} aria-label={`${deleteLabel} ${worktree.branch || folderName(worktree.path)}`}><Icon name="trash" size={14} />{deleteLabel}</button>}</div></article>;
}
