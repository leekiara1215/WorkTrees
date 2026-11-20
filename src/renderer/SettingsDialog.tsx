import { useEffect, useId, useRef, useState } from 'react';
import { THEME_COLORS, type ThemeColor } from '../shared/theme-colors';
import type { AppError, Repository, Settings } from '../shared/types';
import { useSettingsAutosave } from './settings-autosave';
import { appError, ErrorNotice, Icon, Modal, request, Spinner } from './ui';

type PrefixMode = 'inherit' | 'empty' | 'custom';
type PrefixDraft = { mode: PrefixMode; text: string };
const prefixDraft = (prefix: string | null): PrefixDraft => ({
  mode: prefix === null ? 'inherit' : prefix === '' ? 'empty' : 'custom',
  text: prefix ?? '',
});

interface SettingsDialogProps {
  settings: Settings;
  themeColor: ThemeColor;
  onThemeChange: (color: ThemeColor) => void;
  repositories: Repository[];
  onClose: (changed: boolean) => void;
  onRepositoryRemoved: () => void;
}

export function SettingsDialog({ settings, themeColor, onThemeChange, repositories, onClose, onRepositoryRemoved }: SettingsDialogProps) {
  const [root, setRoot] = useState(settings.worktreeRoot);
  const [globalPrefix, setGlobalPrefix] = useState(settings.branchPrefix);
  const [days, setDays] = useState(String(settings.staleDays));
  const [savedPrefix, setSavedPrefix] = useState(settings.branchPrefix);
  const savedTheme = useRef(settings.themeColor);
  const [repos, setRepos] = useState(repositories);
  const [prefixes, setPrefixes] = useState<Record<string, PrefixDraft>>(() => Object.fromEntries(
    repositories.map(repo => [repo.id, prefixDraft(repo.branchPrefix)]),
  ));
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [operation, setOperation] = useState<'directory' | 'remove' | null>(null);
  const operationRef = useRef(false);
  const [operationError, setOperationError] = useState<AppError | null>(null);
  const changed = useRef(false);
  const autosave = useSettingsAutosave();
  const [closing, setClosing] = useState(false);
  const closeAttempt = useRef<Promise<boolean> | null>(null);
  const [closeChoice, setCloseChoice] = useState<((approved: boolean) => void) | null>(null);
  const rootPathId = useId();
  const themeHeadingId = useId();
  const repoHeadingId = useId();
  const locked = !!operation || closing;
  const states = Array.from(autosave.states.values());
  const failed = states.some(state => state.phase === 'failed');
  const writing = states.some(state => state.phase !== 'failed');

  async function saveGlobal(patch: Partial<Settings>) {
    const data = await request(() => window.worktrees.updateSettings(patch));
    savedTheme.current = data.themeColor;
    setSavedPrefix(data.branchPrefix);
    changed.current = true;
  }

  function editRoot(value: string, immediate = false) {
    setRoot(value);
    autosave.schedule('worktreeRoot', () => {
      if (!value.trim()) throw new Error('请输入 Worktree 根路径。');
      return saveGlobal({ worktreeRoot: value.trim() });
    }, immediate ? 0 : undefined);
  }

  function editDays(value: string) {
    setDays(value);
    autosave.schedule('staleDays', () => {
      const staleDays = Number(value);
      if (!/^\d+$/.test(value) || staleDays < 1 || staleDays > 3650) throw new Error('闲置天数请输入 1 至 3650 的整数。');
      return saveGlobal({ staleDays });
    });
  }

  function editRepository(id: string, draft: PrefixDraft, immediate = false) {
    setPrefixes(current => ({ ...current, [id]: draft }));
    autosave.schedule(id, async () => {
      if (draft.mode === 'custom' && !draft.text) throw new Error('请输入自定义前缀。');
      const branchPrefix = draft.mode === 'inherit' ? null : draft.mode === 'empty' ? '' : draft.text;
      const updated = await request(() => window.worktrees.updateRepository(id, { branchPrefix }));
      setRepos(current => current.map(repo => repo.id === id ? updated : repo));
      changed.current = true;
    }, immediate ? 0 : undefined);
  }

  async function chooseRootDirectory() {
    if (operationRef.current || closeAttempt.current) return;
    operationRef.current = true;
    setOperation('directory');
    setOperationError(null);
    try {
      const path = await request(() => window.worktrees.chooseDirectory());
      if (path !== null) editRoot(path, true);
    } catch (error) {
      setOperationError(appError(error));
    } finally {
      operationRef.current = false;
      setOperation(null);
    }
  }

  async function removeRepository(repo: Repository) {
    if (operationRef.current || closeAttempt.current) return;
    operationRef.current = true;
    setOperation('remove');
    setOperationError(null);
    try {
      await autosave.flush(repo.id);
      await request(() => window.worktrees.removeRepository(repo.id));
      autosave.discard(repo.id);
      setRepos(current => current.filter(item => item.id !== repo.id));
      setConfirmRemove(null);
      onRepositoryRemoved();
    } catch (error) {
      setOperationError(appError(error));
    } finally {
      operationRef.current = false;
      setOperation(null);
    }
  }

  function confirmClose() {
    if (closeAttempt.current) return closeAttempt.current;
    if (operationRef.current) return Promise.resolve(false);
    setClosing(true);
    closeAttempt.current = autosave.flush(undefined, true).then(saved => saved || new Promise<boolean>(resolve => {
      setCloseChoice(() => resolve);
    })).finally(() => {
      closeAttempt.current = null;
      setClosing(false);
    });
    return closeAttempt.current;
  }

  const requestClose = useRef(confirmClose);
  requestClose.current = confirmClose;
  useEffect(() => window.worktrees.onCloseRequested(() => requestClose.current()), []);

  async function closeSettings() {
    if (await confirmClose()) onClose(changed.current);
  }

  function answerClose(approved: boolean) {
    if (approved) onThemeChange(savedTheme.current);
    setCloseChoice(null);
    closeChoice?.(approved);
  }

  function feedback(key: string) {
    const state = autosave.states.get(key);
    return state?.phase === 'failed' ? <span className="settings-field-error" role="alert">{state.error.message}</span> : null;
  }

  return <Modal title="偏好设置" onClose={() => closeChoice ? answerClose(false) : void closeSettings()} busy={!!operation || (closing && !closeChoice)} wide>
    <div className="modal-body settings-body" inert={closing}>
      <section aria-labelledby={themeHeadingId}>
        <div className="settings-section-heading"><h3 id={themeHeadingId}>主题色</h3></div>
        <div className="theme-options" role="group" aria-labelledby={themeHeadingId}>
          {THEME_COLORS.map(({ id, label }) => <button key={id} type="button" className="theme-option" data-color={id} aria-pressed={themeColor === id} aria-disabled={locked} onClick={() => {
            if (locked || id === themeColor) return;
            onThemeChange(id);
            autosave.schedule('themeColor', () => saveGlobal({ themeColor: id }), 0);
          }}>
            <span className="theme-swatch">{themeColor === id && <Icon name="check" size={13} />}</span>
            <span>{label}</span>
          </button>)}
        </div>
        {feedback('themeColor')}
      </section>
      <section className="settings-section">
        <div className="settings-section-heading"><h3>全局默认</h3></div>
        <div className="form-stack">
          <div className="field">
            <label htmlFor={rootPathId}>Worktree 根路径</label>
            <div className="directory-picker">
              <input id={rootPathId} value={root} onChange={event => editRoot(event.target.value)} onBlur={() => void autosave.flush('worktreeRoot')} disabled={locked} spellCheck={false} placeholder="~/WorktreesLite" />
              <button type="button" className="button secondary directory-picker-button" onClick={() => void chooseRootDirectory()} disabled={locked}>
                {operation === 'directory' ? <Spinner label="选择中" /> : <><Icon name="folder" size={15} />选择目录</>}
              </button>
            </div>
            <span className="field-hint">支持 <code>&lt;REPOSITORY_PATH&gt;</code> 与 <code>&lt;REPOSITORY_NAME&gt;</code>，创建时预览展开后的路径。</span>
            {feedback('worktreeRoot')}
          </div>
          <div className="form-columns">
            <label className="field">全局分支前缀
              <input value={globalPrefix} onChange={event => {
                const branchPrefix = event.target.value;
                setGlobalPrefix(branchPrefix);
                autosave.schedule('branchPrefix', () => saveGlobal({ branchPrefix }));
              }} onBlur={() => void autosave.flush('branchPrefix')} disabled={locked} placeholder="留空则不加前缀" spellCheck={false} />
              {feedback('branchPrefix')}
            </label>
            <label className="field">闲置天数
              <div className="suffix-input"><input type="number" min="1" max="3650" step="1" value={days} onChange={event => editDays(event.target.value)} onBlur={() => void autosave.flush('staleDays')} disabled={locked} /><span>天</span></div>
              {feedback('staleDays')}
            </label>
          </div>
        </div>
      </section>
      <section className="settings-section" aria-labelledby={repoHeadingId}>
        <div className="settings-section-heading"><h3 id={repoHeadingId}>仓库分支前缀</h3></div>
        {repos.length ? <ul className="settings-repositories">{repos.map(repo => {
          const draft = prefixes[repo.id];
          const effectivePrefix = (repo.branchPrefix ?? savedPrefix) || '无前缀';
          return <li className="settings-repository" key={repo.id}>
            <div className="settings-repo-name"><strong>{repo.name}</strong><small title={repo.path}>{repo.path}</small></div>
            <label className="field settings-repo-mode">
              <select aria-label={`${repo.name}的前缀规则`} value={draft.mode} onChange={event => editRepository(repo.id, { ...draft, mode: event.target.value as PrefixMode }, true)} disabled={locked}>
                <option value="inherit">继承全局</option>
                <option value="empty">不使用前缀</option>
                <option value="custom">自定义前缀</option>
              </select>
            </label>
            <div className="field settings-repo-prefix">
              {draft.mode === 'custom' && <input aria-label={`${repo.name}的自定义前缀`} value={draft.text} onChange={event => editRepository(repo.id, { ...draft, text: event.target.value })} onBlur={() => void autosave.flush(repo.id)} disabled={locked} placeholder="例如 experiment/" spellCheck={false} />}
              <small className="field-hint" title={effectivePrefix}>生效前缀 <code>{effectivePrefix}</code></small>
            </div>
            <button type="button" className="button delete-button" onClick={() => { setConfirmRemove(repo.id); setOperationError(null); }} disabled={locked || confirmRemove === repo.id} aria-label={`移除仓库 ${repo.name}`}><Icon name="trash" size={14} />移除</button>
            <div className="settings-repo-feedback" hidden={autosave.states.get(repo.id)?.phase !== 'failed'}>{feedback(repo.id)}</div>
            {confirmRemove === repo.id && <div className="settings-remove-confirm">
              <p><strong>移除 {repo.name}？</strong><small>{repo.path}</small></p>
              <p>本地文件和 Git 分支将保留。重新导入同一路径即可恢复已保存的设置和 Worktree 记录。</p>
              {autosave.states.has(repo.id) && <p>此仓库仍有待保存的修改。移除前会尝试保存，无法保存的修改将放弃。</p>}
              <ErrorNotice error={operationError} />
              <div className="button-row">
                <button type="button" className="button secondary" onClick={() => setConfirmRemove(null)} disabled={locked} autoFocus>取消</button>
                <button type="button" className="button danger" onClick={() => void removeRepository(repo)} disabled={locked}>{operation === 'remove' ? <Spinner label="移除中" /> : '确认移除'}</button>
              </div>
            </div>}
          </li>;
        })}</ul> : <p className="muted">导入仓库后，可在这里设置分支前缀。</p>}
      </section>
      {!confirmRemove && <ErrorNotice error={operationError} />}
    </div>
    {closeChoice ? <div className="modal-footer settings-close-confirm">
      <div role="alert"><strong>有设置未能保存</strong><p>可继续编辑并查看错误，或放弃这次未保存的修改。</p></div>
      <div className="button-row">
        <button type="button" className="button secondary" onClick={() => answerClose(true)}>放弃未保存修改</button>
        <button type="button" className="button primary" onClick={() => answerClose(false)} autoFocus>继续编辑</button>
      </div>
    </div> : <div className="modal-footer">
      <span className="footer-hint" role="status">{closing || writing ? <Spinner label="正在保存" /> : failed ? '有设置未能保存' : changed.current ? '已保存' : '设置自动保存在本机'}</span>
      <div className="button-row">
        {failed && <button type="button" className="button secondary" onClick={() => void autosave.flush(undefined, true)} disabled={locked}>重试保存</button>}
        <button type="button" className="button primary" onClick={() => void closeSettings()} disabled={locked}>完成</button>
      </div>
    </div>}
  </Modal>;
}
