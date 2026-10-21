import { LOOPS_KEY, LOOP_EPSILON, LOOP_MAX_ENTRIES, LOOP_MIN_SECONDS, LOOP_RESOURCE_COOLDOWN_MS } from './constants.js';
import { filterBackedCells, scenes, seekBases } from './state.js';
import { effectivePlayhead, isTranscodeUrl, stripStart, withStart } from './stream.js';
import { showSpinner } from './ui.js';

// ── A/B loops ──────────────────────────────────────────────────────────
// A loop is a per-scene [a, b] range the cell replays forever instead of
// playing the whole scene: mark A, mark B, and that cell stays on that
// clip while every other cell plays its own. Persisted per scene id in
// localStorage (this browser only) so a reload brings the loops back.
// A stored loop ALWAYS has both marks: setting one mark derives the other
// (A alone means "A to the end", B alone means "start to B"), which keeps
// every consumer free of half-set special cases.
// Filter/roulette cells are excluded by design, same as resume position:
// their scene changes under them, so a scene-keyed loop is meaningless and
// would fight the auto-advance.
export let loopMap = null;
export const loopReloadAt = new Map(); // id -> when this cell last paid for a ?start= reload

export function ensureLoopMap() {
    if (loopMap !== null) return loopMap;
    loopMap = {};
    try {
        const parsed = JSON.parse(localStorage.getItem(LOOPS_KEY) || '{}');
        for (const [key, v] of Object.entries(parsed)) {
            const a = Number(v?.a), b = Number(v?.b);
            if (!isFinite(a) || !isFinite(b) || a < 0) continue;
            if (b - a < LOOP_MIN_SECONDS) continue;
            loopMap[key] = { a, b, half: !!v?.half, u: Number(v?.u) || 0 };
        }
    } catch { loopMap = {}; }
    return loopMap;
}

export function saveLoopMap() {
    const map = ensureLoopMap();
    const keys = Object.keys(map);
    // Loops have no TTL (deleting deliberate user work on a timer would be
    // rude), so cap the map instead: drop the least recently touched.
    if (keys.length > LOOP_MAX_ENTRIES) {
        keys.sort((x, y) => (map[y].u || 0) - (map[x].u || 0))
            .slice(LOOP_MAX_ENTRIES)
            .forEach(k => delete map[k]);
    }
    try { localStorage.setItem(LOOPS_KEY, JSON.stringify(map)); } catch {}
}

export function getLoop(id) {
    if (id == null) return null;
    return ensureLoopMap()[String(id)] || null;
}

export function loopCount() {
    return Object.keys(ensureLoopMap()).length;
}

// Scene-length seconds. Prefer the value from Stash: a transcode started at
// ?start= reports only the REMAINING length, so video.duration can't stand
// in for the scene there.
export function sceneDuration(id, video) {
    const known = scenes[id]?.duration;
    if (known) return known;
    if (!video) return null;
    if (/[?&]start=/.test(video.getAttribute('src') || '')) return null;
    return isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

// `half` means B was derived rather than chosen (the user has only marked A
// so far). It drives the cell button's three-press A -> B -> off cycle.
export function storeLoop(id, a, b, half = false) {
    if (!(b - a >= LOOP_MIN_SECONDS)) return null;
    const map = ensureLoopMap();
    map[String(id)] = { a, b, half, u: Date.now() };
    saveLoopMap();
    syncLoopUI(id);
    return map[String(id)];
}

// Set one mark at `t`. The mark you asked for always lands where you asked;
// the other one only moves if it would leave an unusable range (so marking
// A past the current B re-opens B to the end of the scene rather than
// silently swapping the two behind your back).
export function setLoopPoint(id, which, t, duration) {
    id = String(id);
    const existing = getLoop(id);
    let a, b, half;
    if (which === 'a') {
        a = Math.max(0, t);
        const keep = existing && existing.b - a >= LOOP_MIN_SECONDS;
        b = keep ? existing.b : (duration || a + 30);
        half = keep ? !!existing.half : true;
    } else {
        b = Math.max(0, t);
        const keep = existing && b - existing.a >= LOOP_MIN_SECONDS;
        a = keep ? existing.a : 0;
        half = false;
    }
    if (duration) b = Math.min(b, duration);
    return storeLoop(id, a, b, half);
}

export function clearLoop(id) {
    const map = ensureLoopMap();
    const key = String(id);
    if (!(key in map)) return;
    delete map[key];
    loopReloadAt.delete(key);
    saveLoopMap();
    syncLoopUI(key);
}

export function clearAllLoops() {
    loopMap = {};
    loopReloadAt.clear();
    try { localStorage.removeItem(LOOPS_KEY); } catch {}
    document.querySelectorAll('.mv-cell').forEach(cell => cell._mvSyncLoop?.());
}

// Repaint one cell's loop chrome (seekbar region, badge, button state).
export function syncLoopUI(id) {
    document.querySelector(`.mv-cell[data-scene-id="${id}"]`)?._mvSyncLoop?.();
}

// Send a cell back to its loop start. Returns how it was done:
//  'seek'   - moved the playhead (direct stream, or a transcode that could
//             still seek inside what it had already buffered);
//  'reload' - paid for a fresh ?start= transcode;
//  'wait'   - a reload was due but is still in cooldown; the cell overruns
//             B for now and we try again on the next tick.
// `allowSeek` is how the caller escalates: a "successful" buffer seek that
// silently did nothing is indistinguishable from one that worked until the
// next tick, so the caller stops trusting it after a couple of no-ops.
export function jumpToLoopStart(id, video, a, allowSeek = true) {
    const src = video.getAttribute('src') || '';
    const resumeAutoplay = () => {
        if (video.paused && video.autoplay) video.play().catch(() => {});
    };

    if (!isTranscodeUrl(src)) {
        try { video.currentTime = a; } catch {}
        resumeAutoplay();
        return 'seek';
    }

    // Transcoded: try the buffer first. Local time is scene time minus
    // whatever offset this src was started at.
    const local = a - (/[?&]start=/.test(src) ? (seekBases.get(id) || 0) : 0);
    if (allowSeek && local >= 0 && video.seekable.length) {
        const from = video.seekable.start(0);
        const to = video.seekable.end(video.seekable.length - 1);
        if (local >= from && local <= to) {
            try {
                video.currentTime = local;
                resumeAutoplay();
                return 'seek';
            } catch {}
        }
    }

    const now = Date.now();
    if (now - (loopReloadAt.get(String(id)) || 0) < LOOP_RESOURCE_COOLDOWN_MS) return 'wait';
    loopReloadAt.set(String(id), now);
    const wasPlaying = !video.paused;
    seekBases.set(id, a);
    showSpinner(document.querySelector(`.mv-cell[data-scene-id="${id}"]`));
    const base = stripStart(src);
    video.src = a > 0 ? withStart(base, a) : base;
    if (wasPlaying || video.autoplay) video.play().catch(() => {});
    return 'reload';
}

// A transcode started at ?start= only contains [start, end], so native loop
// would replay just that tail forever. Let this partial pass finish, then
// re-seat the full scene and hand looping back to the browser. Guarded so
// the resume path and a loop being cleared can't both queue the handoff and
// restart the stream twice on one `ended`.
export function seatFullSceneAfterPartialPass(id, video, baseSrc) {
    if (video._mvReseatPending) return;
    video._mvReseatPending = true;
    video.addEventListener('ended', () => {
        video._mvReseatPending = false;
        if (getLoop(id)) return; // a loop was set in the meantime; it drives restarts
        seekBases.set(id, 0);
        video.src = baseSrc;
        video.loop = true;
        video.play().catch(() => {});
    }, { once: true });
}

// Call after any path that points a cell at a new src. A ?start= reload
// only holds [start, end], and a plain cell is natively looped, so without
// this it would replay that tail forever instead of the whole scene.
// Filter cells advance on `ended` and A/B cells drive their own restarts,
// so both are left alone.
export function syncNativeLoop(id, video) {
    if (filterBackedCells.has(String(id)) || getLoop(id)) return;
    applyLoopState(id, video);
}

// Bring one cell's playback in line with its loop state right now, after a
// mark was set, moved or cleared.
export function applyLoopState(id, video) {
    if (!video) return;
    // Filter cells advance to their next scene on `ended`, which native
    // loop would suppress, so they are never looped by either mechanism.
    if (filterBackedCells.has(String(id))) { video.loop = false; return; }
    const loop = getLoop(id);
    const src = video.getAttribute('src') || '';
    const partial = /[?&]start=/.test(src);
    if (!loop) {
        video.loop = !partial;
        if (partial) seatFullSceneAfterPartialPass(id, video, stripStart(src));
        return;
    }
    // Native loop restarts at 0, not at A, so a looping cell drives itself.
    video.loop = false;
    const t = effectivePlayhead(video, id);
    if (t < loop.a || t >= loop.b - LOOP_EPSILON) jumpToLoopStart(id, video, loop.a);
}

// The cell's loop button walks the three states of a hardware A/B button:
// first press marks A, second marks B, third clears.
export function cycleLoopButton(id, video) {
    const loop = getLoop(id);
    if (loop && !loop.half) {
        clearLoop(id);
    } else {
        const which = loop && loop.half ? 'b' : 'a';
        setLoopPoint(id, which, effectivePlayhead(video, id), sceneDuration(id, video));
    }
    applyLoopState(id, video);
}

// Dragging a mark on the seekbar previews live and commits on release, so a
// drag across the bar isn't a storm of localStorage writes and reloads.
export let activeLoopDrag = null; // { id, video, cell, which, seekbar, dur, a, b, half }

export function updateLoopDrag(e) {
    if (!activeLoopDrag) return;
    const { seekbar, dur, which } = activeLoopDrag;
    const rect = seekbar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = ratio * dur;
    let { a, b } = activeLoopDrag;
    if (which === 'a') a = Math.max(0, Math.min(t, b - LOOP_MIN_SECONDS));
    else               b = Math.min(dur, Math.max(t, a + LOOP_MIN_SECONDS));
    if (b - a < LOOP_MIN_SECONDS) return;
    activeLoopDrag.a = a;
    activeLoopDrag.b = b;
    // Moving B by hand makes it a real mark, not a derived one.
    if (which === 'b') activeLoopDrag.half = false;
    activeLoopDrag.cell._mvSyncLoop?.({ a, b, half: activeLoopDrag.half });
}

export function commitLoopDrag() {
    if (!activeLoopDrag) return;
    const { id, video, a, b, half } = activeLoopDrag;
    activeLoopDrag = null;
    storeLoop(id, a, b, half);
    applyLoopState(id, video);
}

export function setActiveLoopDrag(drag) { activeLoopDrag = drag; }
