import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DelegationActivityMonitor,
  DelegationRegistrationStore,
  loadDelegationActivities,
  parseDelegateTaskRegistration,
  resolveHermesHomeForProfile,
  type DelegationActivityScope,
  type DelegationRegistration,
} from '../delegationActivityMonitor';

/** Creating symlinks needs Developer Mode or elevation on Windows. Those tests only apply where it is allowed. */
async function trySymlink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

async function createDelegation(
  hermesHome: string,
  delegationId: string,
  tasks: Array<{ index: number; goal: string; status: string }>,
  layout: 'current' | 'legacy' = 'current',
): Promise<DelegationRegistration> {
  const directory = layout === 'legacy'
    ? path.join(hermesHome, 'delegation_cache', 'live', delegationId)
    : path.join(hermesHome, 'cache', 'delegation', 'live', delegationId);
  await mkdir(directory, { recursive: true });
  const transcriptPaths: string[] = [];
  for (const task of tasks) {
    const transcriptPath = path.join(directory, `task-${task.index}.log`);
    await writeFile(transcriptPath, 'live transcript');
    transcriptPaths.push(transcriptPath);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    delegation_id: delegationId,
    started: '2026-08-10 22:17:01',
    task_count: tasks.length,
    tasks: tasks.map(task => ({ ...task, log: transcriptPaths[task.index] })),
  }));
  return { delegationId, transcriptPaths };
}

test('parses a delegate_task dispatch registration from ACP completion content', () => {
  const registration = parseDelegateTaskRegistration({
    content: [{
      type: 'content',
      content: {
        type: 'text',
        text: JSON.stringify({
          status: 'dispatched',
          delegation_id: 'deleg_abcdef12',
          count: 2,
          goals: ['First goal', 'Second goal'],
          live_transcripts: [
            '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log',
            '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-1.log',
          ],
        }),
      },
    }],
  });

  assert.deepEqual(registration, {
    delegationId: 'deleg_abcdef12',
    transcriptPaths: [
      '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log',
      '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-1.log',
    ],
  });
});

test('prefers compact ACP delegation metadata when polished content is truncated', () => {
  const transcriptPaths = [
    '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log',
    '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-1.log',
    '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-2.log',
  ];
  const registration = parseDelegateTaskRegistration({
    _meta: {
      hermes: {
        delegateTask: {
          schemaVersion: 1,
          status: 'dispatched',
          delegationId: 'deleg_abcdef12',
          taskCount: 3,
          liveTranscripts: transcriptPaths,
        },
      },
    },
    content: [{ type: 'content', content: { type: 'text', text: '{"status":"dispatched"... (truncated)' } }],
  });

  assert.deepEqual(registration, { delegationId: 'deleg_abcdef12', transcriptPaths });
});

test('accepts compact metadata through the configured 100-task boundary', () => {
  const transcriptPaths = Array.from(
    { length: 100 },
    (_, index) => `/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-${index}.log`,
  );
  const payload = (taskCount: number, liveTranscripts: string[]) => ({
    _meta: {
      hermes: {
        delegateTask: {
          schemaVersion: 1,
          status: 'dispatched',
          delegationId: 'deleg_abcdef12',
          taskCount,
          liveTranscripts,
        },
      },
    },
  });

  assert.equal(parseDelegateTaskRegistration(payload(100, transcriptPaths))?.transcriptPaths.length, 100);
  assert.equal(parseDelegateTaskRegistration(payload(101, [
    ...transcriptPaths,
    '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-100.log',
  ])), undefined);
});

test('loads the maximum 100-task manifest with maximum-length goals', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(
    hermesHome,
    'deleg_feedface',
    Array.from({ length: 100 }, (_, index) => ({
      index,
      goal: '🧪'.repeat(500),
      status: 'running',
    })),
  );

  const activities = await loadDelegationActivities(hermesHome, [registration]);
  assert.equal(activities.length, 100);
  assert.ok(activities.every(({ name }) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)));
  assert.ok(activities.every(({ name }) => name.endsWith('...')));
});

test('truncates mixed emoji goals without splitting a grapheme', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const family = '👨‍👩‍👧‍👦';
  const registration = await createDelegation(hermesHome, 'deleg_facefeed', [{
    index: 0,
    goal: `prefix ${family.repeat(60)}`,
    status: 'running',
  }]);

  const activities = await loadDelegationActivities(hermesHome, [registration]);
  assert.equal(activities.length, 1);
  assert.ok(activities[0].name.endsWith(`${family}...`));
});

test('rejects malformed compact ACP delegation metadata without legacy downgrade', () => {
  const registration = parseDelegateTaskRegistration({
    _meta: {
      hermes: {
        delegateTask: {
          schemaVersion: 1,
          status: 'dispatched',
          delegationId: 'deleg_abcdef12',
          taskCount: 2,
          liveTranscripts: ['/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log'],
        },
      },
    },
    rawOutput: JSON.stringify({
      status: 'dispatched',
      delegation_id: 'deleg_abcdef12',
      count: 1,
      goals: ['legacy fallback must not win'],
      live_transcripts: ['/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log'],
    }),
  });

  assert.equal(registration, undefined);
});

test('legacy completion accepts full goals longer than manifest display limits', () => {
  const transcript = '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log';
  const registration = parseDelegateTaskRegistration({
    rawOutput: JSON.stringify({
      status: 'dispatched',
      delegation_id: 'deleg_abcdef12',
      count: 1,
      goals: ['x'.repeat(2_000)],
      live_transcripts: [transcript],
    }),
  });

  assert.deepEqual(registration, {
    delegationId: 'deleg_abcdef12',
    transcriptPaths: [transcript],
  });
});

test('rejects malformed delegate_task dispatch identity and count invariants', () => {
  const transcript = '/tmp/hermes/cache/delegation/live/deleg_abcdef12/task-0.log';
  const parse = (payload: Record<string, unknown>) => parseDelegateTaskRegistration({
    rawOutput: JSON.stringify({
      status: 'dispatched',
      delegation_id: 'deleg_abcdef12',
      live_transcripts: [transcript],
      goals: ['Only goal'],
      ...payload,
    }),
  });

  assert.equal(parse({}), undefined, 'count is mandatory');
  assert.equal(parse({ count: 1, goals: [] }), undefined, 'goals must match count');
  assert.equal(parse({ count: 2 }), undefined, 'count must match transcript count');
  assert.equal(parse({ count: 1, live_transcripts: ['relative/task-0.log'] }), undefined);
  assert.equal(parse({
    count: 2,
    live_transcripts: [
      transcript,
      '/tmp/other/cache/delegation/live/deleg_abcdef12/task-1.log',
    ],
  }), undefined, 'all transcripts must share one absolute delegation directory');
  assert.equal(parseDelegateTaskRegistration({ rawOutput: '{"status":"dispatched"' }), undefined);
  assert.equal(parseDelegateTaskRegistration({ rawOutput: ' '.repeat(128 * 1024 + 1) }), undefined);
});

test('loads only active tasks from a session-registered delegation', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_abcdef12', [
    { index: 0, goal: 'Validate the exact release candidate', status: 'running' },
    { index: 1, goal: 'Review privacy acceptance evidence', status: 'success' },
  ]);

  const activities = await loadDelegationActivities(hermesHome, [registration]);

  assert.deepEqual(activities, [{
    id: 'delegate-task:deleg_abcdef12:0',
    name: 'Delegate · Validate the exact release candidate',
    status: 'running',
  }]);
});

test('loads active tasks from the producer-supported legacy delegation root', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(
    hermesHome,
    'deleg_deadbeef',
    [{ index: 0, goal: 'Legacy-root task', status: 'running' }],
    'legacy',
  );

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), [{
    id: 'delegate-task:deleg_deadbeef:0',
    name: 'Delegate · Legacy-root task',
    status: 'running',
  }]);
});

test('rejects transcript paths outside the active Hermes home', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const foreignHome = await mkdtemp(path.join(tmpdir(), 'foreign-delegation-home-'));
  const registration = await createDelegation(foreignHome, 'deleg_deadbeef', [
    { index: 0, goal: 'Foreign task', status: 'running' },
  ]);

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('rejects malformed manifests with duplicate task identities', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_feedbeef', [
    { index: 0, goal: 'First identity', status: 'running' },
    { index: 0, goal: 'Duplicate identity', status: 'running' },
  ]);

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('rejects a delegation directory symlink that escapes the active Hermes home', async (t) => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const foreignHome = await mkdtemp(path.join(tmpdir(), 'foreign-delegation-home-'));
  const foreign = await createDelegation(foreignHome, 'deleg_feedface', [
    { index: 0, goal: 'Escaped task', status: 'running' },
  ]);
  const liveRoot = path.join(hermesHome, 'cache', 'delegation', 'live');
  await mkdir(liveRoot, { recursive: true });
  if (!(await trySymlink(path.dirname(foreign.transcriptPaths[0]), path.join(liveRoot, 'deleg_feedface')))) {
    t.skip('symlinks are not permitted for this user (Windows needs Developer Mode)');
    return;
  }

  const registration = {
    delegationId: 'deleg_feedface',
    transcriptPaths: [path.join(liveRoot, 'deleg_feedface', 'task-0.log')],
  };
  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('rejects a manifest symlink that escapes the exact delegation directory', async (t) => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const foreignHome = await mkdtemp(path.join(tmpdir(), 'foreign-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_cafebabe', [
    { index: 0, goal: 'Owned task', status: 'running' },
  ]);
  const foreign = await createDelegation(foreignHome, 'deleg_cafebabe', [
    { index: 0, goal: 'Escaped manifest task', status: 'running' },
  ]);
  const directory = path.dirname(registration.transcriptPaths[0]);
  await rename(path.join(directory, 'manifest.json'), path.join(directory, 'manifest-owned.json'));
  if (!(await trySymlink(path.join(path.dirname(foreign.transcriptPaths[0]), 'manifest.json'), path.join(directory, 'manifest.json')))) {
    t.skip('symlinks are not permitted for this user (Windows needs Developer Mode)');
    return;
  }

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('rejects a non-regular manifest without opening it as telemetry', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_d15ea5ed', [
    { index: 0, goal: 'Owned task', status: 'running' },
  ]);
  const directory = path.dirname(registration.transcriptPaths[0]);
  await rename(path.join(directory, 'manifest.json'), path.join(directory, 'manifest-owned.json'));
  await mkdir(path.join(directory, 'manifest.json'));

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('rejects sibling-profile delegation paths after resolving the exact profile home', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-profile-root-'));
  const siblingRegistration = await createDelegation(
    path.join(hermesHome, 'profiles', 'work'),
    'deleg_aabbccdd',
    [{ index: 0, goal: 'Sibling profile task', status: 'running' }],
  );

  assert.deepEqual(await loadDelegationActivities(hermesHome, [siblingRegistration]), []);
});

test('requires manifest task count to match the registered transcript count', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_badc0ffe', [
    { index: 0, goal: 'Only manifest task', status: 'running' },
  ]);
  registration.transcriptPaths.push(path.join(path.dirname(registration.transcriptPaths[0]), 'task-1.log'));

  assert.deepEqual(await loadDelegationActivities(hermesHome, [registration]), []);
});

test('monitor clears delegate_task chips when the ACP generation changes', async () => {
  const hermesHome = await mkdtemp(path.join(tmpdir(), 'hermes-delegation-home-'));
  const registration = await createDelegation(hermesHome, 'deleg_1234abcd', [
    { index: 0, goal: 'Inspect delegated work', status: 'running' },
  ]);
  let scope: DelegationActivityScope | undefined = {
    sessionId: 'session-a',
    generation: 7,
    registrations: [registration],
  };
  const updates: unknown[][] = [];
  const monitor = new DelegationActivityMonitor(
    hermesHome,
    () => scope,
    (_scope, activities) => updates.push(activities),
  );

  await monitor.refresh();
  assert.equal(updates.at(-1)?.length, 1);

  scope = { sessionId: 'session-a', generation: 8, registrations: [] };
  await monitor.refresh();
  assert.deepEqual(updates.at(-1), []);
});

test('registration store exposes delegations only to their owning ACP session generation', () => {
  const store = new DelegationRegistrationStore();
  const registration: DelegationRegistration = {
    delegationId: 'deleg_abcdef12',
    transcriptPaths: ['/tmp/.hermes/cache/delegation/live/deleg_abcdef12/task-0.log'],
  };
  store.register('session-a', 3, registration);

  assert.deepEqual(store.scope('session-a', 3), {
    sessionId: 'session-a',
    generation: 3,
    registrations: [registration],
  });
  assert.deepEqual(store.scope('session-a', 4), {
    sessionId: 'session-a',
    generation: 4,
    registrations: [],
  });
  assert.deepEqual(store.scope('session-b', 3), {
    sessionId: 'session-b',
    generation: 3,
    registrations: [],
  });
  assert.equal(store.scope(undefined, 3), undefined);
});

test('resolves explicit and active named profiles to their isolated Hermes homes', async () => {
  const hermesRoot = await mkdtemp(path.join(tmpdir(), 'hermes-profile-root-'));
  await mkdir(path.join(hermesRoot, 'profiles', 'work'), { recursive: true });
  await writeFile(path.join(hermesRoot, 'active_profile'), 'work\n');

  assert.equal(
    resolveHermesHomeForProfile('work', hermesRoot),
    path.join(hermesRoot, 'profiles', 'work'),
  );
  assert.equal(
    resolveHermesHomeForProfile('', hermesRoot),
    path.join(hermesRoot, 'profiles', 'work'),
  );
  assert.equal(resolveHermesHomeForProfile('default', hermesRoot), hermesRoot);
  assert.equal(resolveHermesHomeForProfile('../escape', hermesRoot), hermesRoot);
});

test('monitor follows the selected profile home after a runtime profile switch', async () => {
  const hermesRoot = await mkdtemp(path.join(tmpdir(), 'hermes-profile-root-'));
  const defaultRegistration = await createDelegation(hermesRoot, 'deleg_1111aaaa', [
    { index: 0, goal: 'Default profile task', status: 'running' },
  ]);
  const workHome = path.join(hermesRoot, 'profiles', 'work');
  const workRegistration = await createDelegation(workHome, 'deleg_2222bbbb', [
    { index: 0, goal: 'Work profile task', status: 'running' },
  ]);
  let hermesHome = hermesRoot;
  let scope: DelegationActivityScope = {
    sessionId: 'session-default',
    generation: 1,
    registrations: [defaultRegistration],
  };
  const updates: unknown[][] = [];
  const monitor = new DelegationActivityMonitor(
    () => hermesHome,
    () => scope,
    (_scope, activities) => updates.push(activities),
  );

  await monitor.refresh();
  assert.equal((updates.at(-1)?.[0] as { name?: string }).name, 'Delegate · Default profile task');

  hermesHome = workHome;
  scope = { sessionId: 'session-work', generation: 2, registrations: [workRegistration] };
  await monitor.refresh();
  assert.equal((updates.at(-1)?.[0] as { name?: string }).name, 'Delegate · Work profile task');
});
