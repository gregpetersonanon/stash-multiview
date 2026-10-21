// ── State ──────────────────────────────────────────────────────────────

export let queue = [];
export let scenes = {};         // id → { id, title, streams }
export const unmutedIds = new Set();
export const seekBases = new Map(); // id → seconds already consumed before current src load
export const filterBackedCells = new Map(); // resolved sceneId → original filter item
// resolved sceneId -> index of its item in the saved queue. The two don't
// line up by position once a filter slot with no match is left off the
// grid, and a filter slot has no id to find it by, so removal uses this.
export const savedQueueIndex = new Map();
export function indexSavedQueue(resolved) {
    savedQueueIndex.clear();
    resolved.forEach((id, i) => { if (id) savedQueueIndex.set(id, i); });
}

export function setQueue(q) { queue = q; }
