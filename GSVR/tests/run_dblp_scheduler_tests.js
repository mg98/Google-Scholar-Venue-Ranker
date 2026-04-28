const assert = require('assert');

const schedulerApi = require('../dblp/dblp_scheduler.js');

function createStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(key) {
      return { [key]: state[key] };
    },
    async set(value) {
      Object.assign(state, value);
    },
  };
}

function createResponse(body, init = {}) {
  return new Response(body, init);
}

async function testSuccessfulRequest() {
  const scheduler = schedulerApi.createDblpScheduler({
    policy: { minDelayMs: 0, jitterMs: [0, 0], retryBackoffMs: [0, 0], maxRetries: 0 },
    fetch: async () => createResponse('ok', { status: 200 }),
  });
  const result = await scheduler.schedule({ url: 'https://dblp.org/search/author/api?q=test' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.bodyText, 'ok');
}

async function testRetryAfterCooldownStored() {
  const storage = createStorage();
  const scheduler = schedulerApi.createDblpScheduler({
    policy: { minDelayMs: 0, jitterMs: [0, 0], retryBackoffMs: [0, 0], maxRetries: 0, globalCooldownStorageKey: 'cooldown' },
    storageArea: storage,
    now: () => 1000,
    fetch: async () => createResponse('limited', {
      status: 429,
      headers: { 'Retry-After': '2' },
    }),
  });
  const result = await scheduler.schedule({ url: 'https://dblp.org/search/author/api?q=test' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.meta.failureKind, 'rate_limited');
  assert.strictEqual(result.meta.retryAfterMs, 2000);
  assert.strictEqual(storage.state.cooldown.cooldownUntil, 3000);
}

async function testDedupesPendingRequests() {
  let fetchCount = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const scheduler = schedulerApi.createDblpScheduler({
    policy: { minDelayMs: 0, jitterMs: [0, 0], retryBackoffMs: [0, 0], maxRetries: 0 },
    fetch: async () => {
      fetchCount += 1;
      return fetchPromise;
    },
  });
  const left = scheduler.schedule({ url: 'https://dblp.org/pid/12/3456.xml', dedupeKey: 'same' });
  const right = scheduler.schedule({ url: 'https://dblp.org/pid/12/3456.xml', dedupeKey: 'same' });
  resolveFetch(createResponse('shared', { status: 200 }));
  const [leftResult, rightResult] = await Promise.all([left, right]);

  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(leftResult.bodyText, 'shared');
  assert.strictEqual(rightResult.bodyText, 'shared');
}

async function testRetriesTransientFailure() {
  let fetchCount = 0;
  const scheduler = schedulerApi.createDblpScheduler({
    policy: { minDelayMs: 0, jitterMs: [0, 0], retryBackoffMs: [0, 0], maxRetries: 1 },
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return createResponse('busy', { status: 500 });
      }
      return createResponse('ok', { status: 200 });
    },
  });
  const result = await scheduler.schedule({ url: 'https://dblp.org/search/author/api?q=test' });

  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.meta.retryCount, 1);
}

async function testWaitBudgetDefersQueuedWork() {
  let fetchCount = 0;
  const scheduler = schedulerApi.createDblpScheduler({
    policy: { minDelayMs: 0, jitterMs: [0, 0], retryBackoffMs: [0, 0], maxRetries: 0 },
    now: () => 1000,
    fetch: async () => {
      fetchCount += 1;
      return createResponse('ok', { status: 200 });
    },
  });
  const result = await scheduler.schedule({
    url: 'https://dblp.org/pid/12/3456.xml',
    waitBudgetMs: 1,
    allowDefer: true,
  });

  assert.strictEqual(fetchCount, 1);
  assert.strictEqual(result.ok, true);
}

async function runDblpSchedulerTests() {
  assert.strictEqual(schedulerApi.DEFAULT_DBLP_REQUEST_POLICY.maxConcurrent, 1);
  assert.strictEqual(schedulerApi.parseRetryAfterMs({ get: () => '3' }, 10000, 0), 3000);
  await testSuccessfulRequest();
  await testRetryAfterCooldownStored();
  await testDedupesPendingRequests();
  await testRetriesTransientFailure();
  await testWaitBudgetDefersQueuedWork();
}

if (require.main === module) {
  runDblpSchedulerTests()
    .then(() => console.log('DBLP scheduler tests passed.'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { runDblpSchedulerTests };
