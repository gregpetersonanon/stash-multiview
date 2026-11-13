// Unit tests for player/queue-store.js against an in-memory fake of Stash's
// plugin config. Run from the repo root with: node --test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Fake Stash: the multiView plugin config map, and a hook to run between
// requests (to simulate another client writing concurrently).
let config, writes, failNext, betweenRequests, holdNextRead;
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
        // Hold this read's response back (it already saw the config as it
        // was), to simulate a slow reply that arrives after other requests.
        if (holdNextRead) { const gate = holdNextRead; holdNextRead = null; await gate; }
    }
    return { json: async () => ({ data }) };
};

const store = await import('../player/queue-store.js');

beforeEach(() => {
    config = {};
    writes = 0;
    failNext = false;
    betweenRequests = null;
    holdNextRead = null;
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

test('two removals made at once both stick', async () => {
    config = { queue: '["1","2","3"]' };
    const drop = id => q => { const i = q.indexOf(id); if (i < 0) return null; q.splice(i, 1); return q; };
    await Promise.all([store.mutateQueue(drop('1')), store.mutateQueue(drop('2'))]);
    assert.deepEqual(JSON.parse(config.queue), ['3']);
    assert.deepEqual(store.cachedQueue(), ['3']);
    assert.equal(store.pendingWrites, 0);
});

test('a refresh that read the config before a write does not cache the old queue', async () => {
    config = { queue: '["1","2","3"]' };
    store.cacheQueue(['1', '2', '3']);
    let release;
    holdNextRead = new Promise(r => { release = r; });
    const refresh = store.refreshQueueCache();      // reads the old queue; reply is slow
    store.cacheQueue(['2', '3']);                   // pane closed: optimistic cache...
    await store.mutateQueue(q => q.filter(id => id !== '1'));   // ...then the write
    release();                                      // the old reply arrives
    assert.equal(await refresh, false);
    assert.deepEqual(store.cachedQueue(), ['2', '3']);
    assert.deepEqual(JSON.parse(config.queue), ['2', '3']);
});

test('a refresh started while a write is in flight does nothing', async () => {
    config = { queue: '["1"]' };
    store.cacheQueue(['1']);
    let release;
    holdNextRead = new Promise(r => { release = r; });
    const write = store.mutateQueue(q => [...q, '2']);   // its read is held
    assert.equal(await store.refreshQueueCache(), false);
    release();
    await write;
    assert.deepEqual(store.cachedQueue(), ['1', '2']);
});

// ── Diagnostic log ───────────────────────────────────────────────────────

const events = () => store.readQueueLog().map(e => e.ev);

test('the log records a write with its label and what it changed', async () => {
    config = { queue: '["1","2"]' };
    await store.mutateQueue(q => q.filter(id => id !== '1'), { label: 'close 1', verify: q => !q.includes('1') });
    const [entry] = store.readQueueLog();
    assert.equal(entry.ev, 'write');
    assert.equal(entry.label, 'close 1');
    assert.deepEqual(entry.removed, ['1']);
    assert.deepEqual(entry.queue, ['2']);
    assert.match(entry.src, /^stash-page#/);   // no /plugin/ path under node
});

test('a failed write is logged, and the poll that restores the queue is not blamed on outside', async () => {
    config = { queue: '["1","2"]' };
    store.cacheQueue(['1', '2']);
    // the close drops "1" from the cache first, as the player does
    store.cacheQueue(['2']);
    failNext = true;
    await store.mutateQueue(q => q.filter(id => id !== '1'), { label: 'close 1' });
    assert.ok(await store.refreshQueueCache());          // config still has "1"
    assert.deepEqual(events(), ['write-failed', 'poll-changed']);
    const poll = store.readQueueLog()[1];
    assert.deepEqual(poll.added, ['1']);
    assert.equal(poll.fromOutside, false);               // a write from here just ended
});

test('a poll change with no recent write from this browser is flagged as from outside', async () => {
    config = { queue: '["2","1"]' };
    store.cacheQueue(['2']);
    assert.ok(await store.refreshQueueCache());
    const [poll] = store.readQueueLog();
    assert.equal(poll.ev, 'poll-changed');
    assert.deepEqual(poll.added, ['1']);
    assert.equal(poll.fromOutside, true);
});

test('repeated poll failures are logged once, and the log is capped', async () => {
    failNext = true; await store.refreshQueueCache();
    failNext = true; await store.refreshQueueCache();
    assert.deepEqual(events(), ['poll-failed']);
    for (let i = 0; i < 450; i++) store.queueLog('x', { i });
    const log = store.readQueueLog();
    assert.equal(log.length, 400);
    assert.equal(log[log.length - 1].i, 449);
    store.clearQueueLog();
    assert.deepEqual(store.readQueueLog(), []);
});
