import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskView } from '@swiftnest/api';
import { TaskList } from '../src/tasks';
import { I18nProvider, translate, type Locale } from '../src/i18n';

const now = Date.now();

function task(overrides: Partial<TaskView> & Pick<TaskView, 'id' | 'status'>): TaskView {
  return { updatedAt: now, events: [], ...overrides };
}

function render(tasks: TaskView[], locale: Locale = 'en') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TaskList tasks={tasks} onOpen={() => {}} />
    </I18nProvider>,
  );
}

describe('task list', () => {
  it('puts running work above finished work', () => {
    const html = render([task({ id: 'done', status: 'completed' }), task({ id: 'live', status: 'running' })]);
    expect(html.indexOf('live')).toBeLessThan(html.indexOf('done'));
  });

  it('labels the five known states in the reader’s language', () => {
    const html = render([task({ id: 'a', status: 'waiting' })], 'zh-CN');
    expect(html).toContain(translate('zh-CN', 'taskStatusWaiting'));
  });

  it('shows a state the client has never seen instead of hiding the task', () => {
    const html = render([task({ id: 'odd-one', status: 'archived-by-server' })]);
    expect(html).toContain('odd-one');
    expect(html).toContain('archived-by-server');
  });

  it('counts steps and shows the newest step kind beside the task', () => {
    const html = render([
      task({
        id: 'worked',
        status: 'running',
        events: [
          { seq: 1, kind: 'start', at: now - 2000, payload: {} },
          { seq: 2, kind: 'bash', at: now, payload: {} },
        ],
      }),
    ]);
    expect(html).toContain('bash');
    expect(html).toContain(`2 ${translate('en', 'tasksSteps')}`);
  });

  it('leaves the timestamp blank when the ledger reports something unreadable', () => {
    const html = render([task({ id: 'broken-time', status: 'queued', updatedAt: 0 })]);
    expect(html).toContain('broken-time');
    expect(html).not.toContain('1970');
  });

  it('marks each state with a tone, not only a word', () => {
    const html = render([
      task({ id: 'a', status: 'failed' }),
      task({ id: 'b', status: 'completed' }),
      task({ id: 'c', status: 'running' }),
    ]);
    expect(html).toContain('pill--danger');
    expect(html).toContain('pill--success');
    expect(html).toContain('pill--accent');
  });
});
