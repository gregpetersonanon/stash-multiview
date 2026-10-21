import { LOOP_EPSILON, SEEK_ZONE_PX } from './constants.js';
import { activeLoopDrag, getLoop, syncNativeLoop } from './loops.js';
import { playerSettings } from './settings.js';
import { seekBases } from './state.js';
import { effectivePlayhead, isTranscodeUrl, stripStart, totalDuration, withStart } from './stream.js';
import { fmtTime, showSpinner } from './ui.js';

export function seekToStart(id, video) {
    const src = video.getAttribute('src');
    const wasPlaying = !video.paused;
    if (isTranscodeUrl(src)) {
        seekBases.set(id, 0);
        video.src = stripStart(src);
        syncNativeLoop(id, video);
    } else {
        video.currentTime = 0;
    }
    if (wasPlaying || video.autoplay) video.play().catch(() => {});
}

// ── Seek modifiers ─────────────────────────────────────────────────────
// Two modifier roles, both user-selectable in Settings. They are roles
// rather than bindings because the keybind format holds a single bare key
// (see normalizeKey) and has nowhere to put a modifier.
//
//  - fine: shrink the seek step, and scale down seekbar drag travel.
//  - allCells: apply the seek to every cell instead of the hovered one.
//
// Ctrl is offered but not the default for either: Ctrl+wheel is the
// browser's zoom gesture, and while our non-passive wheel listener could
// preventDefault it, hijacking a system gesture is not a good default.
export const SEEK_MODIFIERS = [
    { value: 'none',  label: 'None' },
    { value: 'shift', label: 'Shift' },
    { value: 'alt',   label: 'Alt' },
    { value: 'ctrl',  label: 'Ctrl' },
];
// How much a fine drag scales pointer travel. 1/5 turns a 4x4 cell from
// roughly 5.6 seconds per pixel into roughly 1.
export const FINE_DRAG_GAIN = 0.2;
export const SEEK_STEP_MAX = 120;

export function modifierHeld(e, role) {
    if (!e || !role || role === 'none') return false;
    if (role === 'shift') return !!e.shiftKey;
    if (role === 'alt') return !!e.altKey;
    if (role === 'ctrl') return !!(e.ctrlKey || e.metaKey);
    return false;
}
export const isFineSeek = e => modifierHeld(e, playerSettings.fineModifier);
export const isAllCellsSeek = e => modifierHeld(e, playerSettings.allCellsModifier);
export const seekStepFor = e => (isFineSeek(e) ? playerSettings.seekStepFine : playerSettings.seekStep);

// Scroll-wheel skip. Each scroll event accumulates a delta; the actual
// seek fires after a short idle so rapid scrolling on transcoded streams
// doesn't trigger one reload per tick. `extraDelay` staggers a grid-wide
// seek so 16 cells don't all re-request their transcode on the same tick.
export const wheelPending = new Map(); // id -> { delta, timeout }

export function scheduleWheelSeek(id, video, delta, extraDelay = 0) {
    let pending = wheelPending.get(id);
    if (pending) {
        clearTimeout(pending.timeout);
        pending.delta += delta;
    } else {
        pending = { delta };
        wheelPending.set(id, pending);
    }
    pending.timeout = setTimeout(() => {
        const d = pending.delta;
        wheelPending.delete(id);
        applyWheelSeek(id, video, d);
    }, 150 + extraDelay);
}

// Point a transcoded cell at a new src without changing whether it is
// playing. Cells are created with autoplay and never lose it, so a fresh
// src restarts playback on its own and `|| video.autoplay` resumes it
// besides. That breaks the reason to seek while paused at all: pause, walk
// the playhead onto the frame you want, mark it. So drop autoplay while a
// cell is deliberately paused and re-arm it the moment it plays again.
//
// Scoped to user-driven seeks. Stall recovery keeps its own resume rule.
export function resourceKeepingPlayState(video, src) {
    const wasPlaying = !video.paused;
    if (!wasPlaying && video.autoplay) {
        video.autoplay = false;
        video.addEventListener('play', () => { video.autoplay = true; }, { once: true });
    }
    video.src = src;
    if (wasPlaying) video.play().catch(() => {});
}

// Move every cell by the same amount. Each transcoded cell has to re-request
// its stream, so a grid-wide seek is up to 16 fresh encodes: the per-cell
// debounce already collapses a burst of input into one seek each, and the
// stagger keeps those from all landing on the same tick.
export const SEEK_ALL_STAGGER_MS = 60;

export function seekAllCells(delta) {
    document.querySelectorAll('.mv-cell').forEach((cell, i) => {
        const id = cell.dataset.sceneId;
        const video = cell.querySelector('video');
        if (id && video) scheduleWheelSeek(id, video, delta, i * SEEK_ALL_STAGGER_MS);
    });
}

export function applyWheelSeek(id, video, delta) {
    const duration = totalDuration(id, video);
    if (!duration) return;

    const currentSrc = video.getAttribute('src');
    let target = Math.max(0, Math.min(duration - 0.5, effectivePlayhead(video, id) + delta));
    // A looping cell plays a range, so keep a skip inside that range rather
    // than landing outside it and being snapped back by the loop enforcer.
    const loop = getLoop(id);
    if (loop && loop.b > loop.a) target = Math.max(loop.a, Math.min(loop.b - LOOP_EPSILON, target));

    if (isTranscodeUrl(currentSrc)) {
        seekBases.set(id, target);
        showSpinner(document.querySelector(`.mv-cell[data-scene-id="${id}"]`));
        resourceKeepingPlayState(video, withStart(stripStart(currentSrc), target));
        syncNativeLoop(id, video);
    } else {
        video.currentTime = target;
    }

    // Reflect in the seekbar immediately so the user sees feedback
    // before the (possibly slow) transcode reload completes.
    const fill = document.querySelector(`.mv-cell[data-scene-id="${id}"] .mv-seekbar-fill`);
    if (fill) fill.style.transform = 'scaleX(' + (target / duration) + ')';
}

// ── Seek ───────────────────────────────────────────────────────────────

export let activeSeek = null; // { seekbar, fill, video, id, ratio }

// ── Seek zone ──────────────────────────────────────────────────────────
// One cell at a time is "in the zone": pointer near its bottom edge, or the
// cell currently being dragged. Reading a rect per mousemove would force a
// sync layout on every move, so the work is coalesced to one frame.

export let seekZoneCell = null;
export let zonePending = null;
export let zoneRaf = 0;

export function queueSeekZone(e) {
    zonePending = { target: e.target, x: e.clientX, y: e.clientY };
    if (zoneRaf) return;
    zoneRaf = requestAnimationFrame(() => {
        zoneRaf = 0;
        const p = zonePending;
        zonePending = null;
        if (p) updateSeekZone(p);
    });
}

export function setSeekZoneCell(cell) {
    if (cell === seekZoneCell) return;
    if (seekZoneCell) seekZoneCell.classList.remove('mv-seek-zone');
    seekZoneCell = cell;
    if (seekZoneCell) seekZoneCell.classList.add('mv-seek-zone');
}

export function updateSeekZone(p) {
    // render() can replace the cell we were holding; drop the detached node.
    if (seekZoneCell && !seekZoneCell.isConnected) seekZoneCell = null;
    // A drag owns the zone until it ends, even if the pointer wanders off
    // the cell (the bar is still what the user is manipulating).
    const dragging = activeSeek || activeLoopDrag;
    const cell = dragging
        ? (activeSeek ? activeSeek.seekbar.closest('.mv-cell') : activeLoopDrag.cell)
        : (p.target && p.target.closest ? p.target.closest('.mv-cell') : null);
    if (!cell) { setSeekZoneCell(null); return; }
    // The controls row sits mostly inside the zone, and the zone lifts it,
    // so reaching for a button would make it jump away and leave the
    // pointer on the bar. Hovering a control, or using an open volume
    // popup, keeps the zone shut.
    if (!dragging && (cell.classList.contains('mv-popup-open') ||
            (p.target.closest && p.target.closest('.mv-cell-controls .mv-cell-btn, .mv-vol-popup')))) {
        setSeekZoneCell(null);
        return;
    }

    const rect = cell.getBoundingClientRect();
    if (!dragging && p.y < rect.bottom - SEEK_ZONE_PX) { setSeekZoneCell(null); return; }
    setSeekZoneCell(cell);
    // A seek drag paints its own target, which diverges from the pointer
    // once the fine modifier scales the travel down.
    if (!activeSeek && rect.width) paintSeekTime(cell, rect, (p.x - rect.left) / rect.width);
}

// The readout reports the time the cell would seek to. The bar spans the
// cell, so the cell rect and the bar rect are interchangeable here.
export function paintSeekTime(cell, rect, rawRatio) {
    const readout = cell.querySelector('.mv-seek-time');
    if (!readout) return;
    const id = cell.dataset.sceneId;
    const video = cell.querySelector('video');
    const duration = totalDuration(id, video);
    if (!duration) { readout.textContent = ''; return; }
    const ratio = Math.max(0, Math.min(1, rawRatio));
    readout.textContent = fmtTime(ratio * duration) + ' / ' + fmtTime(duration);
    // Cells clip their overflow, so hold the centred bubble far enough in
    // from either edge that it stays whole at 0% and 100%.
    const margin = rect.width ? (readout.offsetWidth / 2 + 4) / rect.width : 0;
    readout.style.left = (100 * Math.max(margin, Math.min(1 - margin, ratio))) + '%';
}

export function updateSeekFill(e) {
    if (!activeSeek) return;
    const rect = activeSeek.seekbar.getBoundingClientRect();
    if (!rect.width) return;

    // Travel from the grab point, scaled. At gain 1 this is identical to
    // reading the pointer position absolutely, so ordinary drags are
    // unchanged; only the fine modifier makes the two differ.
    const fine = isFineSeek(e);
    if (fine !== activeSeek.fine) {
        // Re-anchor on press or release so the fill can't jump mid-drag.
        activeSeek.fine = fine;
        activeSeek.originX = e.clientX;
        activeSeek.originRatio = activeSeek.ratio;
    }
    const travel = (e.clientX - activeSeek.originX) * (fine ? FINE_DRAG_GAIN : 1);
    if (travel) activeSeek.moved = true;
    const ratio = Math.max(0, Math.min(1, activeSeek.originRatio + travel / rect.width));
    activeSeek.ratio = ratio;
    const zoneCell = activeSeek.seekbar.closest('.mv-cell');
    if (zoneCell) paintSeekTime(zoneCell, rect, ratio);
    activeSeek.fill.style.transform = 'scaleX(' + ratio + ')';
}

export function commitSeek() {
    if (!activeSeek || activeSeek.ratio == null) return;
    // A fine grab that never moved is a click to start refining, not a
    // seek request. Committing it would restart the transcode for nothing.
    if (activeSeek.fine && !activeSeek.moved) return;
    const { video, id, ratio } = activeSeek;
    // A single click fires both mousedown and mouseup, each calling
    // commitSeek with the same ratio. Without this guard the transcoder
    // gets two back-to-back src reassignments at the same offset.
    if (activeSeek.lastCommittedRatio === ratio) return;
    activeSeek.lastCommittedRatio = ratio;
    const duration = totalDuration(id, video);
    if (!duration) return;

    const targetTime = ratio * duration;
    const currentSrc = video.getAttribute('src');

    if (isTranscodeUrl(currentSrc)) {
        seekBases.set(id, targetTime);
        showSpinner(document.querySelector(`.mv-cell[data-scene-id="${id}"]`));
        resourceKeepingPlayState(video, withStart(stripStart(currentSrc), targetTime));
        syncNativeLoop(id, video);
    } else {
        video.currentTime = targetTime;
    }
}

export function setActiveSeek(seek) { activeSeek = seek; }
