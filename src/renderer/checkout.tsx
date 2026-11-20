import { useEffect, useRef, useState } from 'react';
import type { AppError, Result, Worktree } from '../shared/types';
import { appError, request, Spinner } from './ui';

export function useCheckout() {
  const active = useRef<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<AppError | null>(null);

  useEffect(() => window.worktrees?.onCloseRequested(async () => !active.current), []);

  async function run(operation: (id: string) => Promise<Result<Worktree>>) {
    if (active.current) return;
    const id = crypto.randomUUID();
    active.current = id;
    setTaskId(id);
    setCancelError(null);
    try {
      return await request(() => operation(id));
    } finally {
      active.current = null;
      setTaskId(null);
      setCancelling(false);
    }
  }

  async function cancel() {
    const id = active.current;
    if (!id || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await request(() => window.worktrees.cancelCheckout(id));
    } catch (error) {
      if (active.current !== id) return;
      setCancelError(appError(error));
      setCancelling(false);
    }
  }

  return { taskId, cancelling, cancelError, run, cancel };
}

export function CheckoutFooter({ label, checkout }: { label: string; checkout: ReturnType<typeof useCheckout> }) {
  const [reminder, setReminder] = useState<{ delay: number } | null>({ delay: 30_000 });
  const [needsChoice, setNeedsChoice] = useState(false);
  const [duration, setDuration] = useState('30000');

  useEffect(() => {
    if (!reminder) return;
    const timer = window.setTimeout(() => setNeedsChoice(true), reminder.delay);
    return () => window.clearTimeout(timer);
  }, [reminder]);

  function continueWaiting() {
    setNeedsChoice(false);
    setReminder(duration === 'unlimited' ? null : { delay: Number(duration) });
  }

  return <div className="modal-footer checkout-footer">
    <div className="checkout-status">
      <div role="status">{checkout.cancelling
        ? <Spinner label="正在取消任务" />
        : needsChoice ? '检出仍在进行。可以继续等待或取消任务。'
        : <Spinner label={reminder ? label : `${label}，等待完成`} />}</div>
      {checkout.cancelError && <span role="alert">{checkout.cancelError.message}</span>}
    </div>
    <div className="button-row">
      {needsChoice && !checkout.cancelling && <>
        <select aria-label="继续等待时长" value={duration} onChange={event => setDuration(event.target.value)}>
          <option value="30000">30 秒后提醒</option>
          <option value="60000">1 分钟后提醒</option>
          <option value="300000">5 分钟后提醒</option>
          <option value="900000">15 分钟后提醒</option>
          <option value="unlimited">等到完成</option>
        </select>
        <button type="button" className="button primary" onClick={continueWaiting}>继续等待</button>
      </>}
      <button type="button" className="button secondary" onClick={() => void checkout.cancel()} disabled={checkout.cancelling}>取消任务</button>
    </div>
  </div>;
}
