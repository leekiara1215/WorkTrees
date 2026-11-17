import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { AppError, Result } from '../shared/types';

export async function request<T>(operation: () => Promise<Result<T>>): Promise<T> {
  if (!window.worktrees) throw { code: 'BRIDGE_UNAVAILABLE', message: '桌面连接尚未就绪，请重新打开应用。' } satisfies AppError;
  const result = await operation();
  if (!result.ok) throw result.error;
  return result.data;
}

export function appError(error: unknown): AppError {
  if (error && typeof error === 'object' && 'message' in error) {
    return { code: 'code' in error ? String(error.code) : 'UNEXPECTED', message: String(error.message), details: 'details' in error && error.details ? String(error.details) : undefined };
  }
  return { code: 'UNEXPECTED', message: '操作未能完成，请稍后重试。' };
}

const icons = {
  branch: <><path d="M6 6v11a3 3 0 0 0 3 3h1M6 10h8a4 4 0 0 0 4-4V4"/><circle cx="6" cy="4" r="2"/><circle cx="12" cy="20" r="2"/><circle cx="18" cy="2" r="2"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/></>,
  settings: <><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/><circle cx="12" cy="12" r="3"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>,
  alert: <><path d="m12 3 10 18H2zM12 9v5"/><path d="M12 17h.01"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/></>,
  layers: <><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  restore: <><path d="M3 4v6h6M4 10a8 8 0 1 1 1 8M12 8v5l3 2"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
};
export function Icon({ name, size = 18, className = '' }: { name: keyof typeof icons; size?: number; className?: string }) {
  return <svg aria-hidden="true" width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}

export function ErrorNotice({ error, onRetry }: { error: AppError | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="error-notice" role="alert"><Icon name="alert" /><div><strong>{error.message}</strong>{error.details && <details><summary>查看详情</summary><p>{error.details}</p></details>}<span className="error-code">{error.code}</span></div>{onRetry && <button type="button" className="text-button" onClick={onRetry}>重试</button>}</div>;
}

export function Modal({ title, subtitle, children, onClose, busy = false, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean }) {
  const titleId = useId();
  const container = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = container.current;
    (panel?.querySelector<HTMLElement>('[autofocus], input, select, button') ?? panel)?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = Array.from(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
      if (!items.length) { event.preventDefault(); container.current?.focus(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [busy]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={container} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-heading"><div><p className="eyebrow">WORKTREES LITE</p><h2 id={titleId}>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose} disabled={busy}><Icon name="close" /></button></div>{children}</div></div>;
}

export function Spinner({ label = '加载中' }: { label?: string }) { return <span className="loading-label"><span className="spinner" aria-hidden="true" />{label}</span>; }
