import { useEffect, useId, useRef, useState } from 'react';
import type { AppError, Branch, CreatePreview, DeleteOutcome, DeletePreview, RecoveryPreview, Repository, Settings, SubmoduleDeletePreview, Worktree } from '../shared/types';
import { appError, ErrorNotice, Icon, Modal, request, Spinner } from './ui';

export function CreateDialog({ repositories, settings, initialRepoId, onClose, onCreated }: { repositories: Repository[]; settings: Settings; initialRepoId: string; onClose: () => void; onCreated: (worktree: Worktree) => void }) {
  const [repoId, setRepoId] = useState(initialRepoId || repositories[0]?.id || '');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState<AppError | null>(null);
  const [branchReload, setBranchReload] = useState(0);
  const [preview, setPreview] = useState<{ key: string; data: CreatePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewReload, setPreviewReload] = useState(0);
  const branchNameId = useId();
  const busyRef = useRef(false);
  const repo = repositories.find(item => item.id === repoId);
  const key = JSON.stringify([repoId, baseBranch, branchName.trim()]);
  const input = { repoId, baseBranch, branchName: branchName.trim() };
  const effectivePrefix = repo?.branchPrefix ?? settings.branchPrefix;

  useEffect(() => {
    let active = true;
    setBranches([]); setBaseBranch(''); setBranchError(null); setBranchesLoading(true);
    request(() => window.worktrees.listBranches(repoId)).then(data => {
      if (!active) return;
      setBranches(data);
      const preferred = data.find(branch => branch.name === repo?.defaultBranch) ?? data.find(branch => branch.current) ?? data.find(branch => !branch.remote) ?? data[0];
      setBaseBranch(preferred?.name ?? '');
    }).catch(error => { if (active) setBranchError(appError(error)); }).finally(() => { if (active) setBranchesLoading(false); });
    return () => { active = false; };
  }, [repoId, branchReload, repo?.defaultBranch]);

  useEffect(() => {
    let active = true;
    setPreview(null); setError(null); setPreviewing(false);
    if (!repoId || !baseBranch || !branchName.trim()) return;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      request(() => window.worktrees.previewCreate({ repoId, baseBranch, branchName: branchName.trim() })).then(data => { if (active) setPreview({ key, data }); }).catch(error => { if (active) setError(appError(error)); }).finally(() => { if (active) setPreviewing(false); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [repoId, baseBranch, branchName, key, previewReload]);

  const currentPreview = preview?.key === key ? preview.data : null;
  function generateBranchName() {
    if (busyRef.current || branchesLoading || previewing) return;
    const today = new Date();
    const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6);
    setBranchName(`work-${date}-${suffix}`);
  }
  async function create() {
    if (busyRef.current || !currentPreview || previewing) return;
    busyRef.current = true; setSaving(true); setError(null);
    try { const worktree = await request(() => window.worktrees.createWorktree(input)); onCreated(worktree); }
    catch (error) { setError(appError(error)); setPreview(null); }
    finally { busyRef.current = false; setSaving(false); }
  }
  return <Modal title="创建 Worktree" subtitle="从一个基准分支，开启独立的工作目录。" onClose={onClose} busy={saving}>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="modal-body form-stack">
        <label className="field">仓库<select value={repoId} onChange={event => setRepoId(event.target.value)} disabled={saving}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
        <label className="field">基准分支<select value={baseBranch} onChange={event => setBaseBranch(event.target.value)} disabled={saving || branchesLoading || !branches.length}><option value="" disabled>{branchesLoading ? '正在读取分支…' : '请选择基准分支'}</option>{branches.map(branch => <option value={branch.name} key={`${branch.remote ? 'remote' : 'local'}:${branch.name}`}>{branch.name}{branch.remote ? ' · 远程' : ''}{branch.current ? ' · 当前' : ''}</option>)}</select></label>
        <ErrorNotice error={branchError} onRetry={() => setBranchReload(value => value + 1)} />
        {!branchesLoading && !branchError && branches.length === 0 && <p className="inline-hint">此仓库还没有可用分支。请先在仓库中创建首个提交，再重新读取分支。</p>}
        <div className="field"><div className="field-heading"><label htmlFor={branchNameId}>分支名称</label><button type="button" className="auto-name-button" onClick={generateBranchName} disabled={saving || branchesLoading || previewing} title="生成不含前缀的日期与随机名称"><Icon name="refresh" size={12} />自动生成</button></div><div className="prefix-input">{effectivePrefix && <span title="当前有效分支前缀">{effectivePrefix}</span>}<input id={branchNameId} aria-describedby={`${branchNameId}-hint`} autoFocus value={branchName} onChange={event => setBranchName(event.target.value)} placeholder="例如 feature/new-design" disabled={saving} autoComplete="off" spellCheck={false} /></div><span className="field-hint" id={`${branchNameId}-hint`}>可手填或自动生成不含前缀的名称。完整分支与目录由下方预览确认。</span></div>
        <div className={`preview-panel ${currentPreview ? 'ready' : ''}`} aria-live="polite"><div className="section-label"><Icon name="branch" size={16} />创建预览{previewing && <Spinner label="正在计算" />}</div>{currentPreview ? <><dl className="preview-values"><div><dt>完整分支</dt><dd>{currentPreview.branch}</dd></div><div><dt>基准分支</dt><dd>{currentPreview.baseBranch}</dd></div><div><dt>完整路径</dt><dd className="path-value">{currentPreview.path}</dd></div></dl>{currentPreview.warnings.length > 0 && <ul className="warning-list">{currentPreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</> : <p className="muted">{previewing ? '正在校验名称与目标目录…' : '选择基准分支并输入名称后，预览完整分支与保存路径。'}</p>}</div>
        <ErrorNotice error={error} onRetry={() => setPreviewReload(value => value + 1)} />
      </div>
      <div className="modal-footer"><span className="footer-hint"><Icon name="folder" size={15} />独立目录，共享 Git 历史</span><div className="button-row"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={saving || previewing || branchesLoading || !currentPreview}>{saving ? <Spinner label="正在创建" /> : <><Icon name="plus" size={16} />确认创建</>}</button></div></div>
    </form>
  </Modal>;
}

type PrefixMode = 'inherit' | 'empty' | 'custom';
function prefixMode(repo?: Repository): PrefixMode { return repo?.branchPrefix === null || repo?.branchPrefix === undefined ? 'inherit' : repo.branchPrefix === '' ? 'empty' : 'custom'; }

export function SettingsDialog({ settings, repositories, initialRepoId, onClose, onUpdated }: { settings: Settings; repositories: Repository[]; initialRepoId: string; onClose: () => void; onUpdated: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [savedSettings, setSavedSettings] = useState(settings);
  const [repoId, setRepoId] = useState(initialRepoId || repositories[0]?.id || '');
  const [localRepos, setLocalRepos] = useState(repositories);
  const repository = localRepos.find(repo => repo.id === repoId);
  const [mode, setMode] = useState<PrefixMode>(prefixMode(repository));
  const [prefix, setPrefix] = useState(repository?.branchPrefix ?? '');
  const [saving, setSaving] = useState<'global' | 'repo' | null>(null);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const rootPathId = useId();
  const [error, setError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState('');
  const [days, setDays] = useState(String(settings.staleDays));
  const busyRef = useRef(false);
  const nextPrefix = mode === 'inherit' ? null : mode === 'empty' ? '' : prefix;
  const globalChanged = draft.worktreeRoot !== savedSettings.worktreeRoot || draft.branchPrefix !== savedSettings.branchPrefix || days !== String(savedSettings.staleDays);
  const daysValid = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650;
  function selectRepository(id: string) {
    const next = localRepos.find(repo => repo.id === id);
    setRepoId(id); setMode(prefixMode(next)); setPrefix(next?.branchPrefix ?? ''); setError(null); setSaved('');
  }
  async function chooseRootDirectory() {
    if (busyRef.current) return;
    busyRef.current = true; setChoosingDirectory(true); setError(null);
    try {
      const path = await request(() => window.worktrees.chooseDirectory());
      if (path !== null) { setDraft(current => ({ ...current, worktreeRoot: path })); setSaved(''); }
    } catch (error) { setError(appError(error)); }
    finally { busyRef.current = false; setChoosingDirectory(false); }
  }
  async function saveGlobal() {
    if (busyRef.current || !daysValid || !draft.worktreeRoot.trim()) return;
    busyRef.current = true; setSaving('global'); setError(null); setSaved('');
    try { const data = await request(() => window.worktrees.updateSettings({ ...draft, worktreeRoot: draft.worktreeRoot.trim(), staleDays: Number(days) })); setDraft(data); setSavedSettings(data); setDays(String(data.staleDays)); setSaved('全局设置已保存'); onUpdated(); }
    catch (error) { setError(appError(error)); }
    finally { busyRef.current = false; setSaving(null); }
  }
  async function saveRepository() {
    if (busyRef.current || !repository) return;
    busyRef.current = true; setSaving('repo'); setError(null); setSaved('');
    try { const data = await request(() => window.worktrees.updateRepository(repoId, { branchPrefix: nextPrefix })); setLocalRepos(items => items.map(item => item.id === data.id ? data : item)); setMode(prefixMode(data)); setPrefix(data.branchPrefix ?? ''); setSaved('仓库前缀已保存'); onUpdated(); }
    catch (error) { setError(appError(error)); }
    finally { busyRef.current = false; setSaving(null); }
  }
  return <Modal title="偏好设置" subtitle="为新的工作目录设定默认规则。" onClose={onClose} busy={(!!saving || choosingDirectory)} wide>
    <div className="modal-body settings-body">
      <section><div className="settings-section-heading"><h3>全局默认</h3><span className="small-badge">新建时生效</span></div><div className="form-stack">
        <div className="field"><label htmlFor={rootPathId}>Worktree 根路径</label><div className="directory-picker"><input id={rootPathId} value={draft.worktreeRoot} onChange={event => { setDraft({ ...draft, worktreeRoot: event.target.value }); setSaved(''); }} disabled={!!saving || choosingDirectory} spellCheck={false} placeholder="~/WorktreesLite" /><button type="button" className="button secondary directory-picker-button" onClick={() => void chooseRootDirectory()} disabled={!!saving || choosingDirectory}>{choosingDirectory ? <Spinner label="选择中" /> : <><Icon name="folder" size={15} />选择目录</>}</button></div><span className="field-hint">支持 <code>&lt;REPOSITORY_PATH&gt;</code> 与 <code>&lt;REPOSITORY_NAME&gt;</code>，创建时会展示展开后的完整路径。选择目录后请保存全局设置。</span></div>
        <div className="form-columns"><label className="field">全局分支前缀<input value={draft.branchPrefix} onChange={event => { setDraft({ ...draft, branchPrefix: event.target.value }); setSaved(''); }} disabled={(!!saving || choosingDirectory)} placeholder="留空则不加前缀" spellCheck={false} /></label><label className="field">闲置天数<div className="suffix-input"><input type="number" min="1" max="3650" step="1" value={days} onChange={event => { setDays(event.target.value); setSaved(''); }} disabled={(!!saving || choosingDirectory)} /><span>天</span></div></label></div>
        {!daysValid && <p className="validation-message">闲置天数请输入 1 至 3650 的整数。</p>}
        <p className="field-hint">闲置状态根据最后活动时间判断。保存这些设置不会移动已有目录或重命名已有分支。</p>
        <div className="align-end"><button className="button secondary" type="button" onClick={() => void saveGlobal()} disabled={(!!saving || choosingDirectory) || !globalChanged || !daysValid || !draft.worktreeRoot.trim()}>{saving === 'global' ? <Spinner label="正在保存" /> : '保存全局设置'}</button></div>
      </div></section>
      <section className="repository-settings"><div className="settings-section-heading"><h3>仓库分支前缀</h3></div>{repositories.length ? <div className="form-stack"><label className="field">仓库<select value={repoId} onChange={event => selectRepository(event.target.value)} disabled={(!!saving || choosingDirectory)}>{localRepos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label><div className="prefix-modes" role="group" aria-label="仓库前缀规则">{([{ id: 'inherit', title: '继承全局', text: savedSettings.branchPrefix || '无前缀' }, { id: 'empty', title: '清空前缀', text: '此仓库不加前缀' }, { id: 'custom', title: '自定义覆盖', text: '使用独立前缀' }] as const).map(item => <label key={item.id} className={`prefix-mode ${mode === item.id ? 'selected' : ''}`}><input type="radio" name="prefix-mode" value={item.id} checked={mode === item.id} onChange={() => { setMode(item.id); setSaved(''); }} disabled={(!!saving || choosingDirectory)} /><span><strong>{item.title}</strong><small>{item.text}</small></span></label>)}</div>{mode === 'custom' && <label className="field">仓库专属前缀<input value={prefix} onChange={event => { setPrefix(event.target.value); setSaved(''); }} disabled={(!!saving || choosingDirectory)} placeholder="例如 experiment/" spellCheck={false} /></label>}<div className="effective-prefix"><span>当前选择的有效前缀</span><code>{(mode === 'inherit' ? savedSettings.branchPrefix : nextPrefix) || '无前缀'}</code></div><div className="align-end"><button type="button" className="button secondary" onClick={() => void saveRepository()} disabled={(!!saving || choosingDirectory) || nextPrefix === repository?.branchPrefix || (mode === 'custom' && !prefix)}>{saving === 'repo' ? <Spinner label="正在保存" /> : '保存仓库前缀'}</button></div></div> : <p className="muted">导入仓库后，可在这里配置仓库专属前缀。</p>}</section>
      <ErrorNotice error={error} />{saved && <p className="saved-notice" role="status"><Icon name="check" size={16} />{saved}</p>}
    </div><div className="modal-footer"><span className="footer-hint">设置仅保存在本机</span><button type="button" className="button primary" onClick={onClose} disabled={(!!saving || choosingDirectory)}>完成</button></div>
  </Modal>;
}

export function RecoveryDialog({ worktree, onClose, onRecovered }: { worktree: Worktree; onClose: () => void; onRecovered: (worktree: Worktree) => void }) {
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setPreview(null);
    request(() => window.worktrees.previewRecovery(worktree.id)).then(data => { if (active) setPreview(data); }).catch(error => { if (active) setError(appError(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [worktree.id, reload]);
  async function recover() {
    if (busyRef.current || !preview) return;
    busyRef.current = true; setSaving(true); setError(null);
    try { const data = await request(() => window.worktrees.recreateWorktree(worktree.id)); onRecovered(data); }
    catch (error) { setError(appError(error)); setPreview(null); }
    finally { busyRef.current = false; setSaving(false); }
  }
  return <Modal title="重建缺失 Worktree" subtitle="使用保存的记录，重新创建工作目录。" onClose={onClose} busy={saving}>
    <div className="modal-body form-stack">{loading && <div className="dialog-loading"><Spinner label="正在检查分支与目录" /></div>}{preview && <><div className="recovery-explanation"><span className="recovery-icon"><Icon name="restore" size={23} /></span><div><strong>{preview.action === 'recreate-existing-branch' ? '使用已有分支重建' : '从记录的基准分支重建'}</strong><p>{preview.action === 'recreate-existing-branch' ? '分支仍然存在，将检出该分支到原目录。' : '原分支已不存在，将从下方基准分支重新创建分支与目录。'}</p></div></div><div className="preview-panel ready"><dl className="preview-values"><div><dt>仓库</dt><dd>{worktree.repoName}</dd></div><div><dt>目标分支</dt><dd>{preview.branch}</dd></div>{preview.action === 'recreate-from-base' && <div><dt>基准分支</dt><dd>{preview.baseBranch ?? '无可用基准分支'}</dd></div>}<div><dt>恢复目录</dt><dd className="path-value">{preview.path}</dd></div></dl></div>{preview.warnings.length > 0 && <ul className="warning-list">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<div className="safety-note"><Icon name="alert" size={18} /><p>重建不会恢复未提交的文件。目标目录必须不存在，已有目录不会被覆盖。</p></div></>}<ErrorNotice error={error} onRetry={() => setReload(value => value + 1)} /></div>
    <div className="modal-footer"><span className="footer-hint">失败后保留记录，可再次重试</span><div className="button-row"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="button" className="button primary" onClick={() => void recover()} disabled={saving || loading || !preview || (preview.action === 'recreate-from-base' && !preview.baseBranch)}>{saving ? <Spinner label="正在重建" /> : <><Icon name="restore" size={16} />确认重建</>}</button></div></div>
  </Modal>;
}

export function DeleteDialog({ worktree, onClose, onDeleted }: { worktree: Worktree; onClose: () => void; onDeleted: (outcome: DeleteOutcome) => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: DeletePreview } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [discardSubmodules, setDiscardSubmodules] = useState<string[]>([]);
  const [confirmSubmoduleFiles, setConfirmSubmoduleFiles] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<AppError | null>(null);
  const [operationError, setOperationError] = useState<AppError | null>(null);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const key = JSON.stringify([worktree.id, deleteBranch, reload]);
  const currentPreview = preview?.key === key ? preview.data : null;
  const displayedBranch = currentPreview ? currentPreview.branch : worktree.branch;
  const hasFiles = (module: SubmoduleDeletePreview) => module.trackedChanges + module.untrackedFiles + module.ignoredFiles > 0;
  const canDelete = !worktree.isMain && !worktree.locked && !loading && !!currentPreview && (!currentPreview.requiresConfirmation || confirmed) && currentPreview.submodules.every(m => !hasFiles(m) || confirmSubmoduleFiles.includes(m.path));
  function toggleSelection(set: (update: (previous: string[]) => string[]) => void, path: string, checked: boolean) {
    set(previous => checked ? [...previous.filter(item => item !== path), path] : previous.filter(item => item !== path));
  }

  useEffect(() => {
    let active = true;
    setLoading(true); setPreview(null); setPreviewError(null); setConfirmed(false);
    setDiscardSubmodules([]); setConfirmSubmoduleFiles([]);
    request(() => window.worktrees.previewDelete(worktree.id, deleteBranch)).then(data => {
      if (active) setPreview({ key, data });
    }).catch(error => { if (active) setPreviewError(appError(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [worktree.id, deleteBranch, key]);

  function refreshPreview() {
    if (busyRef.current) return;
    setConfirmed(false); setOperationError(null); setPreview(null); setReload(value => value + 1);
  }
  async function remove() {
    if (busyRef.current || !canDelete || !currentPreview) return;
    busyRef.current = true; setSaving(true); setOperationError(null);
    try {
      const result = await request(() => window.worktrees.deleteWorktree({ worktreeId: worktree.id, deleteBranch: currentPreview.deleteBranch, token: currentPreview.token, confirmRisks: confirmed, discardSubmodules, confirmSubmoduleFiles }));
      onDeleted(result);
    } catch (error) {
      setOperationError(appError(error)); setConfirmed(false); setPreview(null); setReload(value => value + 1);
    } finally { busyRef.current = false; setSaving(false); }
  }
  return <Modal title="安全删除 Worktree" subtitle="确认工作目录和检查结果后，再执行删除。" onClose={onClose} busy={saving}>
    <div className="modal-body form-stack">
      <div className="preview-panel delete-target"><dl className="preview-values"><div><dt>仓库</dt><dd>{worktree.repoName}</dd></div><div><dt>分支</dt><dd>{displayedBranch || '游离 HEAD'}</dd></div>{currentPreview?.head && <div><dt>当前提交</dt><dd>{currentPreview.head.slice(0, 12)}</dd></div>}<div><dt>删除目录</dt><dd className="path-value">{currentPreview?.path || worktree.path}</dd></div></dl></div>
      {displayedBranch ? <label className="delete-option"><input type="checkbox" checked={deleteBranch} onChange={event => { setDeleteBranch(event.target.checked); setConfirmed(false); setPreview(null); setOperationError(null); }} disabled={saving} /><span><strong>同时删除本地分支</strong><small>{deleteBranch ? '删除分支前，会检查其他分支和标签未包含的提交。' : '默认只删除工作目录，保留本地分支和已提交的代码。'}</small></span></label> : <p className="inline-hint">当前处于游离 HEAD，将检查是否有未被分支或标签保留的提交。</p>}
      {loading && <div className="dialog-loading"><Spinner label="正在检查修改与提交" /></div>}
      {currentPreview && <>
        <div className="delete-checks" aria-live="polite"><div><span>已跟踪文件修改</span><strong>{currentPreview.trackedChanges}</strong></div><div><span>未跟踪文件</span><strong>{currentPreview.untrackedFiles}</strong></div><div><span>被忽略的文件</span><strong>{currentPreview.ignoredFiles}</strong></div><div><span>其他引用未包含的提交</span><strong>{currentPreview.uniqueCommits}</strong></div></div>
        {currentPreview.submodules.length > 0 && <section className="submodule-checks" aria-label="子模块删除检查">
          <div className="submodule-heading"><h3>子模块检查 · {currentPreview.submodules.length}</h3><p>比较基准：{currentPreview.baseBranch ?? '无可用基准'}{currentPreview.baseHead ? ` · ${currentPreview.baseHead.slice(0, 12)}` : ''}</p><p>默认保留分支及提交；保留成功后再删除目录。未提交文件需单独确认丢弃。</p></div>
          {currentPreview.submodules.map(module => <div className="submodule-check" key={module.path}>
            <strong className="submodule-path">{module.path}</strong>
            <dl className="preview-values">
              <div><dt>分支</dt><dd>{module.branch ?? (module.head ? '游离 HEAD' : '未初始化')}</dd></div>
              <div><dt>当前提交</dt><dd>{module.head?.slice(0, 12) ?? '无本地检出'}{module.state === 'missing-worktree' ? ' · 工作目录缺失，仍有本地 Git 数据' : ''}</dd></div>
              <div><dt>基准提交</dt><dd>{module.baseHead?.slice(0, 12) ?? '基准中无此模块或无法读取'}</dd></div>
              <div><dt>检查结果</dt><dd>{module.state === 'uninitialized' ? '未初始化，无本地分支或文件需要保留' : module.comparison === 'same' ? '与基准一致，无需确认放弃分支' : module.comparison === 'different' ? `与基准不同 · 领先 ${module.ahead} / 落后 ${module.behind} 个提交` : '无法确认与基准的提交关系，默认保留'}</dd></div>
            </dl>
            {module.protectionReason && <p className="inline-hint">{module.protectionReason}</p>}
            {module.canDiscard && <label className="delete-option risk-confirmation"><input type="checkbox" checked={discardSubmodules.includes(module.path)} onChange={event => toggleSelection(setDiscardSubmodules, module.path, event.target.checked)} disabled={saving} /><span><strong>{module.branch ? `不保留此子模块分支 ${module.branch}` : '不保留此子模块的游离提交'}</strong><small>允许丢失此分支或游离 HEAD 的独有提交；其他分支和标签等引用仍会保留。不勾选时先保留，再删除目录。</small></span></label>}
            {hasFiles(module) && <label className="delete-option risk-confirmation"><input type="checkbox" checked={confirmSubmoduleFiles.includes(module.path)} onChange={event => toggleSelection(setConfirmSubmoduleFiles, module.path, event.target.checked)} disabled={saving} /><span><strong>确认丢弃此子模块的本地文件修改</strong><small>已跟踪修改 {module.trackedChanges} 项、未跟踪文件 {module.untrackedFiles} 个、忽略文件 {module.ignoredFiles} 个。保留分支无法保存这些文件。</small></span></label>}
          </div>)}
          <p className="submodule-summary">{currentPreview.submodules.filter(m => m.head).length - discardSubmodules.length} 个子模块保留当前分支或提交；{discardSubmodules.length} 个明确放弃保留。所有子模块工作目录将随 Worktree 删除。</p>
        </section>}
        {currentPreview.warnings.length > 0 && <ul className="warning-list">{currentPreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <div className="safety-note delete-safety-note"><Icon name="alert" size={18} /><p>删除会移除上述目录及其中的文件。{currentPreview.deleteBranch ? '所选本地分支也会删除。' : currentPreview.branch ? '本地分支将保留。' : '游离 HEAD 没有对应的本地分支。'}此操作无法在应用内撤销。</p></div>
        {currentPreview.requiresConfirmation && <label className="delete-option risk-confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={saving} /><span><strong>我已确认以上风险，并同意删除</strong><small>未提交、未跟踪及被忽略的文件可能永久丢失；删除分支或游离 HEAD 可能丢失独有提交。</small></span></label>}
      </>}
      <ErrorNotice error={operationError} />
      <ErrorNotice error={previewError} onRetry={refreshPreview} />
    </div>
    <div className="modal-footer"><button type="button" className="text-button" onClick={refreshPreview} disabled={saving || loading}>重新检查</button><div className="button-row"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="button" className="button danger" onClick={() => void remove()} disabled={saving || !canDelete}>{saving ? <Spinner label="正在删除" /> : <><Icon name="trash" size={15} />{deleteBranch ? '删除目录与分支' : '确认删除目录'}</>}</button></div></div>
  </Modal>;
}
