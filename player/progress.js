import { PROGRESS_KEY, PROGRESS_MAX_AGE_MS, PROGRESS_MIN_SAVE, PROGRESS_SAVE_INTERVAL_MS } from './constants.js';
import { getLoop } from './loops.js';
import { filterBackedCells } from './state.js';
import { effectivePlayhead } from './stream.js';

// ── Resume position ────────────────────────────────────────────────────
// Per-scene playback position persisted to localStorage so a reload
// resumes where you left off. In-memory map + a single interval that
// snapshots all cells every PROGRESS_SAVE_INTERVAL_MS; localStorage is
// written at most once per tick (plus an immediate flush on pagehide /
// visibility-hidden). Filter/roulette cells are excluded by design —
// their position has no meaning across reloads. TTL-pruned at 7 days.
export let progressMap = null;
export let progressMapDirty = false;
export let progressSaveTimer = null;

export function ensureProgressMap() {
    if (progressMap !== null) return progressMap;
    try {
        progressMap = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        const now = Date.now();
        for (const k of Object.keys(progressMap)) {
            if (!progressMap[k] || now - (progressMap[k].u || 0) > PROGRESS_MAX_AGE_MS) {
                delete progressMap[k];
                progressMapDirty = true;
            }
        }
        if (progressMapDirty) flushProgressMap();
    } catch {
        progressMap = {};
    }
    return progressMap;
}

export function flushProgressMap() {
    if (!progressMapDirty || progressMap === null) return;
    try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progressMap));
        progressMapDirty = false;
    } catch {}
}

export function getResumeTime(id) {
    return ensureProgressMap()[String(id)]?.t || 0;
}

export function setResumeTime(id, t) {
    if (!(t >= PROGRESS_MIN_SAVE)) return;
    const map = ensureProgressMap();
    map[String(id)] = { t, u: Date.now() };
    progressMapDirty = true;
}

export function clearResumeTime(id) {
    const map = ensureProgressMap();
    const key = String(id);
    // `delete` returns true even for an absent key, so check presence to
    // avoid marking the map dirty (and re-writing localStorage) for no-ops.
    if (key in map) { delete map[key]; progressMapDirty = true; }
}

// Snapshot every non-filter cell's effective playhead into the map.
export function snapshotAllProgress() {
    document.querySelectorAll('.mv-cell').forEach(cell => {
        const id = cell.dataset.sceneId;
        if (!id || filterBackedCells.has(id)) return;
        // A looping cell has no meaningful "where I left off": its position
        // is somewhere inside the loop, and resuming there on reload would
        // just fight the loop. It reopens at A instead.
        if (getLoop(id)) return;
        const video = cell.querySelector('video');
        if (!video) return;
        setResumeTime(id, effectivePlayhead(video, id));
    });
}

export function startProgressSaveLoop() {
    if (progressSaveTimer) return;
    progressSaveTimer = setInterval(() => {
        snapshotAllProgress();
        flushProgressMap();
    }, PROGRESS_SAVE_INTERVAL_MS);
}
