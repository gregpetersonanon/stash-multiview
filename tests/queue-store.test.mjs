// Unit tests for player/queue-store.js against an in-memory fake of Stash's
// plugin config. Run from the repo root with: node --test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Fake Stash: the multiView plugin config map, and a hook to run between
// requests (to simulate another client writing concurrently).
let config, writes, failNext, betweenRequests;
const storage = new Map();
globalThis.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
};
globalThis.fetch = async (_url, opts) => {
    betweenRequests?.();
    if (failNext) { failNext = false; throw new TypeError('network down'); }
    const { query, variables } = JSON.parse(opts.body);
    let data;
    if (query.includes('configurePlugin')) {
        writes++;
        config = { ...variables.input };   // replaces the whole map, as Stash does
        data = { configurePlugin: config };
    } else {
        data = { configuration: { plugins: { multiView: { ...config } } } };
    }
    return { json: async () => ({ data }) };
};

const store = await import('../player/queue-store.js');

beforeEach(() => {
    config = {};
    writes = 0;
    failNext = false;
    betweenRequests = null;
    storage.clear();
});

test('a queue write keeps the plugin config keys it does not touch', async () => {
    config = { queue: '["1"]', watched: '[{"id":"9"}]', player: '{"holder":"a"}' };
    const result = await store.mutateQueue(q => [...q, '2']);
    assert.deepEqual(result, ['1', '2']);
    assert.deepEqual(config, { queue: '["1","2"]', watched: '[{"id":"9"}]', player: '{"holder":"a"}' });
    assert.deepEqual(store.cachedQueue(), ['1', '2']);
});

test('a mutator returning null writes nothing and caches the live queue', async () => {
    config = { queue: '["5"]' };
    store.cacheQueue(['stale']);
    const result = await store.mutateQueue(() => null);
    assert.equal(writes, 0);
    assert.deepEqual(result, ['5']);
    assert.deepEqual(store.cachedQueue(), ['5']);
});

test('verify re-applies the change when another client overwrote it', async () => {
    config = { queue: '[]' };
    let clobbered = false;
    // Right after our first write lands, another client writes its own queue.
    betweenRequests = () => {
        if (writes === 1 && !clobbered) { clobbered = true; config = { queue: '["other"]' }; }
    };
    const result = await store.mutateQueue(q => (q.includes('7') ? null : [...q, '7']),
        { verify: q => q.includes('7') });
    assert.deepEqual(result, ['other', '7']);
    assert.equal(writes, 2);
});

test('a network failure leaves the cache alone and clears the write count', async () => {
    store.cacheQueue(['1']);
    failNext = true;
    const result = await store.mutateQueue(q => [...q, '2']);
    assert.deepEqual(result, ['1']);
    assert.equal(store.pendingWrites, 0);
    assert.equal(writes, 0);
});

test('refreshQueueCache reports whether the cached queue changed', async () => {
    config = { queue: '["1","2"]' };
    assert.equal(await store.refreshQueueCache(), true);
    assert.deepEqual(store.cachedQueue(), ['1', '2']);
    assert.equal(await store.refreshQueueCache(), false);
    failNext = true;
    assert.equal(await store.refreshQueueCache(), false);
    assert.deepEqual(store.cachedQueue(), ['1', '2']);
});

test('a malformed stored queue reads as empty', async () => {
    config = { queue: 'not json' };
    assert.deepEqual(await store.fetchQueue(), []);
    storage.set('stash-multiview-queue', '{"not":"a list"}');
    assert.deepEqual(store.cachedQueue(), []);
});
