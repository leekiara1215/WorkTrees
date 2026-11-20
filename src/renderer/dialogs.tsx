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
  const [preview, setPreview] = useState<{ key: string; data: CreatePreview } | { key: string; error: AppError } | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewReload, setPreviewReload] = useState(0);
  const branchNameId = useId();
  const busyRef = useRef(false);
  const previewRequest = useRef<Promise<CreatePreview> | null>(null);
  const repo = repositories.find(item => item.id === repoId);
  const name = branchName.trim();
  const key = JSON.stringify([repoId, baseBranch, name, previewReload]);
  const input = { repoId, baseBranch, branchName: name };
  const effectivePrefix = repo?.branchPrefix ?? settings.branchPrefix;
  const canPreview = !!(repoId && baseBranch && name && !branchesLoading);

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
    if (!canPreview) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      await previewRequest.current?.catch(() => undefined);
      if (!active) return;
      const pending = request(() => window.worktrees.previewCreate({ repoId, baseBranch, branchName: name }));
      previewRequest.current = pending;
      try {
        const data = await pending;
        if (active) setPreview({ key, data });
      } catch (error) {
        if (active) setPreview({ key, error: appError(error) });
      } finally {
        if (previewRequest.current === pending) previewRequest.current = null;
      }
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [repoId, baseBranch, name, key, canPreview]);

  const result = canPreview && preview?.key === key ? preview : null;
  const currentPreview = result && 'data' in result ? result.data : null;
  const error = result && 'error' in result ? result.error : null;
  const previewing = canPreview && !result;
  function updateBranchName(value: string) {
    if (value.trim() !== name) setPreview(null);
    setBranchName(value);
  }
  function generateBranchName() {
    if (busyRef.current || branchesLoading) return;
    const today = new Date();
    const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6);
    updateBranchName(`work-${date}-${suffix}`);
  }
  async function create() {
    if (busyRef.current || !currentPreview) return;
    busyRef.current = true; setSaving(true);
    try { const worktree = await request(() => window.worktrees.createWorktree(input)); onCreated(worktree); }
    catch (error) { setPreview({ key, error: appError(error) }); }
    finally { busyRef.current = false; setSaving(false); }
  }
  return <Modal title="创建 Worktree" subtitle="从一个基准分支，开启独立的工作目录。" onClose={onClose} busy={saving}>
    <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="modal-body form-stack">
        <label className="field">仓库<select value={repoId} onChange={event => { setRepoId(event.target.value); setBaseBranch(''); setBranchesLoading(true); setPreview(null); }} disabled={saving}>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
        <label className="field">基准分支<select value={baseBranch} onChange={event => { setBaseBranch(event.target.value); setPreview(null); }} disabled={saving || branchesLoading || !branches.length}><option value="" disabled>{branchesLoading ? '正在读取分支…' : '请选择基准分支'}</option>{branches.map(branch => <option value={branch.name} key={`${branch.remote ? 'remote' : 'local'}:${branch.name}`}>{branch.name}{branch.remote ? ' · 远程' : ''}{branch.current ? ' · 当前' : ''}</option>)}</select></label>
        <ErrorNotice error={branchError} onRetry={() => setBranchReload(value => value + 1)} />
        {!branchesLoading && !branchError && branches.length === 0 && <p className="inline-hint">此仓库还没有可用分支。请先在仓库中创建首个提交，再重新读取分支。</p>}
        <div className="field"><div className="field-heading"><label htmlFor={branchNameId}>分支名称</label><button type="button" className="auto-name-button" onClick={generateBranchName} disabled={saving || branchesLoading} title="生成不含前缀的日期与随机名称"><Icon name="refresh" size={12} />自动生成</button></div><div className="prefix-input">{effectivePrefix && <span title="当前有效分支前缀">{effectivePrefix}</span>}<input id={branchNameId} aria-describedby={`${branchNameId}-hint`} autoFocus value={branchName} onChange={event => updateBranchName(event.target.value)} placeholder="例如 feature/new-design" disabled={saving} autoComplete="off" spellCheck={false} /></div><span className="field-hint" id={`${branchNameId}-hint`}>可手填或自动生成不含前缀的名称。完整分支与目录由下方预览确认。</span></div>
        <section className="preview-panel create-preview ready" aria-labelledby={`${branchNameId}-preview`}>
          <div className="section-label">
            <Icon name="branch" size={16} /><span id={`${branchNameId}-preview`}>创建预览</span>
            <span className="create-preview-status" role="status">{previewing ? <Spinner label="校验中" /> : currentPreview ? '校验通过' : error ? '校验失败' : '等待输入'}</span>
          </div>
          <div className="create-preview-content" tabIndex={0} aria-label="分支、路径和校验结果">
            <dl className="preview-values">
              <div><dt>完整分支</dt><dd>{currentPreview?.branch ?? (name ? effectivePrefix + name : '—')}</dd></div>
              <div><dt>基准分支</dt><dd>{baseBranch || '—'}</dd></div>
              <div><dt>完整路径</dt><dd className="path-value">{currentPreview?.path ?? '—'}</dd></div>
            </dl>
            {!!currentPreview?.warnings.length && <ul className="warning-list">{currentPreview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
            <ErrorNotice error={error} onRetry={() => setPreviewReload(value => value + 1)} />
          </div>
        </section>
      </div>
      <div className="modal-footer"><span className="footer-hint"><Icon name="folder" size={15} />独立目录，共享 Git 历史</span><div className="button-row"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button type="submit" className="button primary" disabled={saving || previewing || branchesLoading || !currentPreview}>{saving ? <Spinner label="正在创建" /> : <><Icon name="plus" size={16} />确认创建</>}</button></div></div>
    </form>
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
