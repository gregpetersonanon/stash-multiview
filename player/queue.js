import { disconnectAudio } from './audio.js';
import { STORAGE_KEY } from './constants.js';
import { buildSceneFilter } from './filters.js';
import { clearResumeTime } from './progress.js';
import { render } from './render.js';
import { loadSceneMeta } from './scenes-api.js';
import { seekToStart } from './seek.js';
import { filterBackedCells, indexSavedQueue, queue, savedQueueIndex, seekBases, setQueue, unmutedIds } from './state.js';

// ── Queue ──────────────────────────────────────────────────────────────

export function getQueue() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
}

export function saveQueue(q) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(q));
}

// ── Shared queue source of truth: Stash plugin config ────────────
// The queue is shared with the Stash scene-list plugin, binge web,
// binge-iOS, and multiview-ios. Config is authoritative; localStorage
// is a local cache. The player seeds the cache from config on load,
// polls it, and writes its own changes (remove tile / roulette) back
// to config via read-modify-write so it never clobbers a concurrent
// change from another client.
export async function fetchConfigQueue() {
    const r = await fetch('/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ configuration { plugins } }' })
    });
    const j = await r.json();
    const raw = j?.data?.configuration?.plugins?.multiView?.queue;
    try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
}

export async function writeConfigQueue(q) {
    await fetch('/graphql', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: 'mutation($input: Map!) { configurePlugin(plugin_id: "multiView", input: $input) }',
            variables: { input: { queue: JSON.stringify(q) } }
        })
    });
}

// Number of in-flight config writes — the poll skips while > 0 so it
// can't seed the cache from a not-yet-committed config and revert our
// own just-made change.
export let pendingConfigWrites = 0;

// Read-modify-write the live config queue (one pass: read fresh, apply
// mutator, write — so a concurrent add elsewhere is preserved). Also
// mirrors the result into the local cache.
export async function mutateConfigQueue(mutator) {
    pendingConfigWrites++;
    try {
        let items;
        try { items = await fetchConfigQueue(); }
        catch { return; }
        const next = mutator(items.slice());
        if (next === null) { saveQueue(items); return; }
        try { await writeConfigQueue(next); } catch { return; }
        saveQueue(next);
    } finally { pendingConfigWrites--; }
}

// Seed/refresh the local cache from config. Returns true if the cache
// changed (so the caller can re-resolve + re-render the wall).
export async function seedCacheFromConfig() {
    try {
        const q = await fetchConfigQueue();
        const next = JSON.stringify(q);
        if (next !== localStorage.getItem(STORAGE_KEY)) {
            localStorage.setItem(STORAGE_KEY, next);
            return true;
        }
    } catch { /* offline — keep cache */ }
    return false;
}

// Re-resolve the wall from the current cache (shared by the storage
// event + the config poll). Preserves currently-playing filter slots.
export function resyncFromCache() {
    resolveQueuePreserving(getQueue()).then(resolved => {
        setQueue(resolved);
        loadSceneMeta(queue).then(render);
    });
}
// Up to `count` random scene ids matching a filter slot.
export async function fetchFilterCandidates(item, count) {
    try {
        const f = item.filter || {};
        const findFilter = { per_page: count, sort: 'random' };
        if (f.q) findFilter.q = f.q;
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `query($filter: FindFilterType, $scene_filter: SceneFilterType) { findScenes(filter: $filter, scene_filter: $scene_filter) { scenes { id } } }`,
                variables: { filter: findFilter, scene_filter: buildSceneFilter(f) }
            })
        });
        const data = await res.json();
        const list = data?.data?.findScenes?.scenes || [];
        return list.map(s => String(s.id));
    } catch { return []; }
}

// A grid shows one cell per scene id, so a filter slot must never land on
// a scene that is already on screen: the duplicate's cell would vanish
// and, if it collided with a pinned scene, take over that cell. `taken`
// holds the ids already placed. Asking for taken.size + 1 random matches
// guarantees a free one whenever the filter has that many; null means
// every match is already showing.
export async function resolveFilterSlot(item, taken) {
    const ids = await fetchFilterCandidates(item, taken.size + 1);
    return ids.find(id => !taken.has(id)) || null;
}

// Place every filter slot on a distinct scene. Candidates are fetched in
// parallel, then handed out in queue order. Each slot asks for as many
// candidates as the queue has items, so (as above) a free one is always
// in its list when the filter has enough matches. A slot with none left
// is dropped from the grid.
export async function assignFilterSlots(rawQueue, taken, preset = []) {
    const candidates = await Promise.all(rawQueue.map((item, i) =>
        (typeof item === 'string' || preset[i]) ? null : fetchFilterCandidates(item, rawQueue.length)));
    return rawQueue.map((item, i) => {
        if (typeof item === 'string') return item;
        if (preset[i]) return preset[i];
        const id = candidates[i].find(c => !taken.has(c)) || null;
        if (id) taken.add(id);
        return id;
    });
}

export async function resolveQueue(rawQueue) {
    filterBackedCells.clear();
    const taken = new Set(rawQueue.filter(item => typeof item === 'string'));
    const resolved = await assignFilterSlots(rawQueue, taken);
    resolved.forEach((id, i) => { if (id && typeof rawQueue[i] !== 'string') filterBackedCells.set(id, rawQueue[i]); });
    indexSavedQueue(resolved);
    return resolved.filter(Boolean);
}

// Like resolveQueue but reuses currently-playing IDs for existing filter slots
// so adding a scene from Stash doesn't interrupt videos already playing.
// Reuse is decided first so new picks can avoid the reused scenes, and a
// playing scene that has since been pinned by hand is not reused.
export async function resolveQueuePreserving(rawQueue) {
    const available = new Map();
    for (const [id, item] of filterBackedCells) {
        const key = JSON.stringify(item.filter || {});
        if (!available.has(key)) available.set(key, []);
        available.get(key).push(id);
    }
    const taken = new Set(rawQueue.filter(item => typeof item === 'string'));
    const reused = rawQueue.map(item => {
        if (typeof item === 'string') return null;
        const pool = available.get(JSON.stringify(item.filter || {})) || [];
        while (pool.length > 0) {
            const id = pool.shift();
            if (!taken.has(id)) { taken.add(id); return id; }
        }
        return null;
    });
    const resolved = await assignFilterSlots(rawQueue, taken, reused);
    const newFilterBackedCells = new Map();
    resolved.forEach((id, i) => { if (id && typeof rawQueue[i] !== 'string') newFilterBackedCells.set(id, rawQueue[i]); });
    filterBackedCells.clear();
    for (const [k, v] of newFilterBackedCells) filterBackedCells.set(k, v);
    indexSavedQueue(resolved);
    return resolved.filter(Boolean);
}

export function removeScene(id) {
    id = String(id);
    const idx = queue.indexOf(id);
    if (idx === -1) return;
    queue.splice(idx, 1);
    // A scene-id string removes by value (robust against a changed
    // queue). A filter slot has no id, so it is found by its own index in
    // the saved queue, checked to still hold the same filter; if another
    // client has moved things since, the first slot with that filter goes.
    const filterItem = filterBackedCells.get(id);
    const savedIdx = savedQueueIndex.get(id);
    const filterKey = filterItem && JSON.stringify(filterItem.filter || {});
    const isSlot = it => !!it && typeof it === 'object' && JSON.stringify(it.filter || {}) === filterKey;
    const dropItem = items => {
        const k = !filterItem ? items.indexOf(id)
            : (savedIdx != null && isSlot(items[savedIdx])) ? savedIdx
            : items.findIndex(isSlot);
        if (k < 0) return null;
        items.splice(k, 1);
        return items;
    };
    const raw = dropItem(getQueue());
    if (raw) saveQueue(raw);
    savedQueueIndex.delete(id);
    if (savedIdx != null) {
        for (const [k, v] of savedQueueIndex) if (v > savedIdx) savedQueueIndex.set(k, v - 1);
    }
    // Persist the removal to config (RMW) so other clients see it.
    mutateConfigQueue(dropItem);
    unmutedIds.delete(String(id));
    filterBackedCells.delete(String(id));
    disconnectAudio(id);
    seekBases.delete(id);
    clearResumeTime(id);
    render();
}

export async function advanceFilterCell(id) {
    const filterItem = filterBackedCells.get(id);
    if (!filterItem) return;
    // `queue` includes this cell's own scene, so the pick is always new.
    // Re-check after the await: another cell may have advanced onto it.
    const newId = await resolveFilterSlot(filterItem, new Set(queue));
    if (!newId || queue.includes(newId)) {
        const cell = document.querySelector(`.mv-cell[data-scene-id="${id}"]`);
        const video = cell?.querySelector('video');
        if (video) seekToStart(id, video);
        return;
    }
    filterBackedCells.delete(id);
    filterBackedCells.set(newId, filterItem);
    if (savedQueueIndex.has(id)) {
        savedQueueIndex.set(newId, savedQueueIndex.get(id));
        savedQueueIndex.delete(id);
    }
    if (unmutedIds.has(id)) { unmutedIds.delete(id); unmutedIds.add(newId); }
    const qIdx = queue.indexOf(id);
    if (qIdx !== -1) queue[qIdx] = newId;
    await loadSceneMeta([newId]);
    render();
}
