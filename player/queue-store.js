// ── Queue store ────────────────────────────────────────────────────────
// The one place that reads and writes the plugin's saved state in Stash's
// config (configuration.plugins.multiView). Used by the player and by the
// Stash-side script (multiView.js loads it with a dynamic import), so it has
// no imports of its own.
//
// Stash's configurePlugin replaces the plugin's whole config map, so every
// write here reads the current map and writes all of it back, changing only
// the keys being updated. Values are stored as JSON strings.
//
// localStorage keeps a copy of the queue so pages can render it without a
// round trip; the config is always the source of truth.

const PLUGIN_ID = 'multiView';
const CACHE_KEY = 'stash-multiview-queue';

// ── Diagnostic log ──────────────────────────────────────────────────────
// A record of every queue write and every poll that changed the queue, from
// every page of this browser that loads this module (the player and the
// Stash pages), kept in localStorage so all tabs add to one list. Meant for
// working out where an unexpected queue change came from: each entry says
// which page logged it, and a poll that finds a change no write from this
// browser explains is marked as coming from outside it (another browser or
// device, or another app writing the same config).

const LOG_KEY = 'stash-multiview-queue-log';
const LOG_MAX = 400;
// last time a write from this browser finished (any tab)
const LAST_WRITE_KEY = 'stash-multiview-last-write';
// A poll this long after the last write from this browser can't be seeing
// that write land.
const OWN_WRITE_WINDOW_MS = 10000;

const logSource = (() => {
    const page = typeof location !== 'undefined' && location.pathname.startsWith('/plugin/')
        ? 'player' : 'stash-page';
    return page + '#' + Math.random().toString(36).slice(2, 6);
})();

// Appends one entry: { t, src, ev, ...details }. Never throws.
export function queueLog(ev, details) {
    try {
        const log = readQueueLog();
        log.push({ t: new Date().toISOString(), src: logSource, ev, ...(details || {}) });
        localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX)));
    } catch {}
}

export function readQueueLog() {
    try { const a = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
}

export function clearQueueLog() {
    try { localStorage.removeItem(LOG_KEY); } catch {}
}

// Scene ids (and filter slots, as "filter:<json>") in b but not a.
function queueDiff(a, b) {
    const key = item => typeof item === 'string' ? item : 'filter:' + JSON.stringify(item && item.filter || {});
    const count = list => list.reduce((m, it) => m.set(key(it), (m.get(key(it)) || 0) + 1), new Map());
    const ca = count(a), cb = count(b);
    const added = [], removed = [];
    for (const [k, n] of cb) for (let i = ca.get(k) || 0; i < n; i++) added.push(k);
    for (const [k, n] of ca) for (let i = cb.get(k) || 0; i < n; i++) removed.push(k);
    return { added, removed };
}

async function gql(query, variables) {
    const r = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
}

function parseList(raw) {
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
}

// The plugin's whole config map, values as stored (JSON strings).
async function fetchPluginConfig() {
    const data = await gql('{ configuration { plugins } }');
    return { ...(data?.configuration?.plugins?.[PLUGIN_ID] || {}) };
}

async function writePluginConfig(map) {
    await gql(`mutation($input: Map!) { configurePlugin(plugin_id: "${PLUGIN_ID}", input: $input) }`,
        { input: map });
}

export async function fetchQueue() {
    return parseList((await fetchPluginConfig()).queue);
}

// The cached copy of the queue, for synchronous reads.
export function cachedQueue() {
    try { return parseList(localStorage.getItem(CACHE_KEY)); }
    catch { return []; }
}

export function cacheQueue(q) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(q)); } catch {}
}

// Fires in other tabs of the same browser when the cached queue changes.
export function isQueueCacheEvent(storageEvent) {
    return storageEvent.key === CACHE_KEY;
}

// Writes in flight from this page. A poll should skip while this is above 0:
// reading the config mid-write could put the old queue back in the cache.
export let pendingWrites = 0;

// Changes whenever a write starts or ends on any page of this browser. A
// read that sees it change while in flight may hold a queue from before a
// write, so refreshQueueCache throws it away rather than cache it. Kept in
// localStorage so it also covers a write made from another tab (the player
// and the Stash pages each load their own copy of this module).
const GEN_KEY = 'stash-multiview-queue-gen';
let localGen = 0;
function writeGen() {
    let shared = null;
    try { shared = localStorage.getItem(GEN_KEY); } catch {}
    return `${shared}:${localGen}`;
}
function bumpWriteGen() {
    localGen++;
    try { localStorage.setItem(GEN_KEY, `${Date.now()}-${Math.random()}`); } catch {}
}

// Writes from this page run one at a time. Each reads the config, changes
// it and writes the whole map back, so two that overlapped would both read
// the same queue and the second would undo the first.
let writeChain = Promise.resolve();

// Read-modify-write the queue. `mutator(items)` gets a copy of the live queue
// and returns the new one, or null to change nothing. With `verify`, the
// queue is read back after writing and the change re-applied (up to 4 tries)
// until `verify(queue)` holds, since a concurrent writer elsewhere could have
// overwritten it. Returns the queue as last seen, and caches it; on a network
// failure returns the cached copy unchanged. `label` names the change in the
// diagnostic log ("close 123").
export function mutateQueue(mutator, opts) {
    // Counted before waiting for earlier writes, so a poll skips from the
    // moment the change is asked for.
    pendingWrites++;
    bumpWriteGen();
    const run = writeChain.then(() => runMutation(mutator, opts));
    writeChain = run;
    return run.finally(() => {
        try { localStorage.setItem(LAST_WRITE_KEY, String(Date.now())); } catch {}
        bumpWriteGen();
        pendingWrites--;
    });
}

async function runMutation(mutator, { verify, label = 'write' } = {}) {
    try {
        for (let attempt = 0; attempt < 4; attempt++) {
            const map = await fetchPluginConfig();
            const items = parseList(map.queue);
            const next = mutator(items.slice());
            if (next === null) {
                queueLog('write-unneeded', { label, queue: items });
                cacheQueue(items);
                return items;
            }
            map.queue = JSON.stringify(next);
            await writePluginConfig(map);
            if (!verify) {
                queueLog('write', { label, ...queueDiff(items, next), queue: next });
                cacheQueue(next);
                return next;
            }
            const after = await fetchQueue();
            if (verify(after)) {
                queueLog('write', { label, attempt: attempt + 1, ...queueDiff(items, after), queue: after });
                cacheQueue(after);
                return after;
            }
            queueLog('write-overwritten', { label, attempt: attempt + 1, wrote: next, readBack: after });
        }
        const latest = await fetchQueue();
        queueLog('write-gave-up', { label, queue: latest });
        cacheQueue(latest);
        return latest;
    } catch (e) {
        // the change stays only in the local cache; the next poll will
        // replace it with whatever the config still holds
        queueLog('write-failed', { label, error: String(e && e.message || e) });
        return cachedQueue();
    }
}

// Refresh the cached queue from the config. Returns true if it changed.
// Does nothing, and returns false, if a write started or ended while the
// config was being read: the queue read could be from before that write.
export async function refreshQueueCache() {
    if (pendingWrites > 0) return false;
    const gen = writeGen();
    try {
        const q = await fetchQueue();
        if (pendingWrites > 0 || writeGen() !== gen) return false;
        let current = null;
        try { current = localStorage.getItem(CACHE_KEY); } catch {}
        if (JSON.stringify(q) === current) return false;
        let lastWrite = 0;
        try { lastWrite = Number(localStorage.getItem(LAST_WRITE_KEY)) || 0; } catch {}
        queueLog(current === null ? 'first-load' : 'poll-changed', {
            ...queueDiff(parseList(current), q),
            // nothing this browser wrote recently can explain the change
            ...(current === null ? {} : { fromOutside: Date.now() - lastWrite > OWN_WRITE_WINDOW_MS }),
            queue: q,
        });
        cacheQueue(q);
        return true;
    } catch (e) {
        // offline: keep the cache. Logged once per run of failures.
        const msg = String(e && e.message || e);
        const last = readQueueLog().slice(-1)[0];
        if (!(last && last.ev === 'poll-failed' && last.error === msg && last.src === logSource)) {
            queueLog('poll-failed', { error: msg });
        }
        return false;
    }
}
