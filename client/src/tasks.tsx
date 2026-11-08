/**
 * The task ledger page: what every work unit has done, grouped by state.
 *
 * Reading rules (grouping, ordering, timestamps) live in `taskState.ts` so they can
 * be tested without a server. This file is only the screen: three states, and a
 * sheet that shows a task's steps without leaving the list.
 */
import { useCallback, useEffect, useState } from 'react';
import type { LedgerEvent, TaskView } from '@swiftnest/api';
import { Button } from './components/Button';
import { ListRow } from './components/ListRow';
import { Pill } from './components/Pill';
import { Sheet } from './components/Sheet';
import { HubPage } from './components/pages';
import { useConnection } from './connection';
import { relativeLastSeen } from './devices/relativeLastSeen';
import { useI18n } from './i18n';
import { groupTasks, taskSummary, updatedAtMs } from './taskState';
import type { StringKey } from './i18n';

/** Known ledger states. Anything else is server data and is shown as it arrived. */
const STATUS_KEYS: Record<string, StringKey> = {
  running: 'taskStatusRunning',
  waiting: 'taskStatusWaiting',
  queued: 'taskStatusQueued',
  completed: 'taskStatusCompleted',
  failed: 'taskStatusFailed',
};

const STATUS_TONES: Record<string, 'accent' | 'waiting' | 'neutral' | 'success' | 'danger'> = {
  running: 'accent',
  waiting: 'waiting',
  queued: 'neutral',
  completed: 'success',
  failed: 'danger',
};

function statusLabel(key: (key: StringKey) => string, status: string): string {
  const lookup = STATUS_KEYS[status];
  return lookup ? key(lookup) : status;
}

function useTasks() {
  const { store, status } = useConnection();
  const client = status === 'connected' ? store.client : undefined;
  const [tasks, setTasks] = useState<readonly TaskView[]>();
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setTasks(await client.listTasks());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client]);
  useEffect(() => {
    if (!client) {
      setTasks(undefined);
      setFailed(false);
      return;
    }
    void refresh();
    // The ledger grows while a Bot works; a short poll keeps the list honest.
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [client, refresh]);
  return { tasks, failed, refresh };
}

function when(updatedAt: TaskView['updatedAt'], locale: 'en' | 'zh-CN', now: number): string | undefined {
  const ms = updatedAtMs(updatedAt);
  // An unreadable timestamp must stay blank, not read as 1970.
  return ms ? relativeLastSeen(new Date(ms).toISOString(), locale, now) : undefined;
}

/** The grouped list on its own, so its markup can be checked without a server. */
export function TaskList({ tasks, onOpen }: { tasks: readonly TaskView[]; onOpen: (task: TaskView) => void }) {
  const { t, locale } = useI18n();
  const now = Date.now();
  return (
    <>
      {groupTasks(tasks).map((group) => (
        <section key={group.status} className="task-group" aria-labelledby={`task-group-${group.status}`}>
          <h2 id={`task-group-${group.status}`}>{statusLabel(t, group.status)}</h2>
          {group.tasks.map((task) => {
            const summary = taskSummary(task);
            const subtitle = [
              summary.latest?.kind,
              `${summary.steps} ${t('tasksSteps')}`,
              when(task.updatedAt, locale, now),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <ListRow
                key={task.id}
                title={task.id}
                subtitle={subtitle}
                value={<Pill tone={STATUS_TONES[task.status] ?? 'neutral'}>{statusLabel(t, task.status)}</Pill>}
                chevron
                onClick={() => onOpen(task)}
              />
            );
          })}
        </section>
      ))}
    </>
  );
}

function TaskEvent({ event }: { event: LedgerEvent }) {
  const { t, locale } = useI18n();
  return (
    <li>
      <ListRow
        title={event.kind}
        subtitle={new Date(event.at).toLocaleString(locale)}
        value={<code>{event.seq}</code>}
      />
      <details>
        <summary>{t('taskEventPayload')}</summary>
        <pre className="task-payload">{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </li>
  );
}

function TaskDetail({ task, onClose }: { task?: TaskView; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet
      open={!!task}
      title={task?.id ?? ''}
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      {task && (
        <>
          <p>
            {statusLabel(t, task.status)}
            {' · '}
            {task.events.length} {t('tasksSteps')}
          </p>
          {task.events.length === 0 ? (
            <p>{t('tasksNoSteps')}</p>
          ) : (
            <ol className="task-events">
              {[...task.events]
                .sort((a, b) => a.seq - b.seq)
                .map((event) => (
                  <TaskEvent key={event.seq} event={event} />
                ))}
            </ol>
          )}
        </>
      )}
    </Sheet>
  );
}

export function TasksPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { status } = useConnection();
  const { tasks, failed, refresh } = useTasks();
  const [open, setOpen] = useState<TaskView>();
  return (
    <HubPage title={t('tasksTitle')} subtitle={t('tasksHelp')} onBack={onBack}>
      {status !== 'connected' ? (
        <p role="status">{t('tasksNeedsConnection')}</p>
      ) : failed ? (
        <>
          <p role="alert">{t('tasksLoadFailed')}</p>
          <Button onClick={() => void refresh()}>{t('retry')}</Button>
        </>
      ) : !tasks ? (
        <p role="status" aria-busy="true">
          {t('tasksLoading')}
        </p>
      ) : tasks.length === 0 ? (
        <>
          <p>{t('tasksEmpty')}</p>
          <p className="plugin-muted">{t('tasksEmptyHelp')}</p>
        </>
      ) : (
        <TaskList tasks={tasks} onOpen={setOpen} />
      )}
      <TaskDetail task={open} onClose={() => setOpen(undefined)} />
    </HubPage>
  );
}
