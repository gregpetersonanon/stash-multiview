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
// failure returns the cached copy unchanged.
export function mutateQueue(mutator, opts) {
    // Counted before waiting for earlier writes, so a poll skips from the
    // moment the change is asked for.
    pendingWrites++;
    bumpWriteGen();
    const run = writeChain.then(() => runMutation(mutator, opts));
    writeChain = run;
    return run.finally(() => {
        bumpWriteGen();
        pendingWrites--;
    });
}

async function runMutation(mutator, { verify } = {}) {
    try {
        for (let attempt = 0; attempt < 4; attempt++) {
            const map = await fetchPluginConfig();
            const items = parseList(map.queue);
            const next = mutator(items.slice());
            if (next === null) { cacheQueue(items); return items; }
            map.queue = JSON.stringify(next);
            await writePluginConfig(map);
            if (!verify) { cacheQueue(next); return next; }
            const after = await fetchQueue();
            if (verify(after)) { cacheQueue(after); return after; }
        }
        const latest = await fetchQueue();
        cacheQueue(latest);
        return latest;
    } catch {
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
        cacheQueue(q);
        return true;
    } catch {
        return false;   // offline: keep the cache
    }
}
