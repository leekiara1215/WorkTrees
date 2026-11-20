import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../shared/types';
import { appError } from './ui';

type SaveState = { phase: 'waiting' | 'ready' | 'saving' } | { phase: 'failed'; error: AppError };
type Job = { save: () => Promise<void>; state: SaveState; timer?: number };

export function useSettingsAutosave() {
  const jobs = useRef(new Map<string, Job>());
  const running = useRef<Promise<void> | null>(null);
  const [states, setStates] = useState(new Map<string, SaveState>());

  useEffect(() => {
    const pending = jobs.current;
    return () => {
      for (const job of pending.values()) window.clearTimeout(job.timer);
      pending.clear();
    };
  }, []);

  function publish() {
    setStates(new Map(Array.from(jobs.current, ([key, job]) => [key, job.state])));
  }

  function drain() {
    running.current ??= Promise.resolve().then(async () => {
      try {
        for (let next = findReady(); next; next = findReady()) {
          const [key, job] = next;
          job.state = { phase: 'saving' };
          publish();
          try {
            await job.save();
            if (jobs.current.get(key) === job) jobs.current.delete(key);
          } catch (error) {
            if (jobs.current.get(key) === job) job.state = { phase: 'failed', error: appError(error) };
          }
          publish();
        }
      } finally {
        running.current = null;
      }
    });
    return running.current;
  }

  function findReady() {
    return Array.from(jobs.current).find(([, job]) => job.state.phase === 'ready');
  }

  function discard(key: string) {
    window.clearTimeout(jobs.current.get(key)?.timer);
    jobs.current.delete(key);
    publish();
  }

  function schedule(key: string, save: Job['save'], delay = 500) {
    window.clearTimeout(jobs.current.get(key)?.timer);
    const job: Job = { save, state: { phase: delay ? 'waiting' : 'ready' } };
    jobs.current.set(key, job);
    publish();
    if (!delay) {
      void drain();
      return;
    }
    job.timer = window.setTimeout(() => {
      job.state = { phase: 'ready' };
      void drain();
    }, delay);
  }

  async function flush(key?: string, retry = false) {
    for (const [id, job] of jobs.current) {
      if ((key === undefined || id === key) && (job.state.phase === 'waiting' || (retry && job.state.phase === 'failed'))) {
        window.clearTimeout(job.timer);
        job.state = { phase: 'ready' };
      }
    }
    await drain();
    return key === undefined ? jobs.current.size === 0 : !jobs.current.has(key);
  }

  return { schedule, flush, discard, states };
}
