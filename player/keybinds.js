import { toggleAudio } from './audio.js';
import { toggleFocusMode } from './layout.js';
import { applyLoopState, clearLoop, getLoop, sceneDuration, setLoopPoint } from './loops.js';
import { openMenuPanel } from './menu.js';
import { incrementO } from './scenes-api.js';
import { isAllCellsSeek, isFineSeek, scheduleWheelSeek, seekAllCells, seekStepFor } from './seek.js';
import { playerSettings } from './settings.js';
import { filterBackedCells } from './state.js';
import { effectivePlayhead } from './stream.js';
import { toggleFullscreen } from './topbar.js';

// Rebindable keyboard shortcuts. `run` is invoked when the bound key fires;
// it references module functions that are hoisted/defined by run() time.
// Stored keys are normalized (single letters lower-cased, ' ' -> 'Space').
// Rebindable shortcuts. A binding string is either a normalized keyboard key
// (single letters lower-cased, ' ' -> 'Space') or a mouse button ('Mouse<n>'
// where n is event.button: 1 middle, 2 right, 3 back, 4 forward). `run` gets
// the originating event so cell-scoped actions can find the target.
// The "All" actions live as top-bar buttons; shortcuts instead target the
// single cell under the cursor so a mouse button can act on one panel.
export const KEYBIND_ACTIONS = [
    { id: 'playPauseHover', label: 'Play / Pause (hovered)',  run: e => playPauseHoveredCell(e) },
    { id: 'muteHover',      label: 'Mute / Unmute (hovered)', run: e => muteHoveredCell(e) },
    { id: 'oHover',         label: 'O counter (hovered)',     run: e => oHoveredCell(e) },
    { id: 'loopSetA',       label: 'Loop: set A (hovered)',   run: e => setLoopMarkOnHovered(e, 'a') },
    { id: 'loopSetB',       label: 'Loop: set B (hovered)',   run: e => setLoopMarkOnHovered(e, 'b') },
    { id: 'loopClear',      label: 'Loop: clear (hovered)',   run: e => clearLoopOnHovered(e) },
    { id: 'seekBack',       label: 'Seek back (hovered)',     run: e => nudgeHovered(e, -1) },
    { id: 'seekForward',    label: 'Seek forward (hovered)',  run: e => nudgeHovered(e, 1) },
    { id: 'focus',          label: 'Toggle Focus Mode',       run: () => toggleFocusMode() },
    { id: 'fullscreen',     label: 'Toggle Full Screen',      run: () => toggleFullscreen() },
    { id: 'roulette',       label: 'Open Roulette',           run: () => openMenuPanel() },
];
export const DEFAULT_KEYBINDS = { playPauseHover: '', muteHover: 'Mouse1', oHover: '', loopSetA: 'a', loopSetB: 'b', loopClear: 'l', seekBack: 'ArrowLeft', seekForward: 'ArrowRight', focus: 'f', fullscreen: '', roulette: '' };
// Targets where a non-left button keeps its native meaning, so a mouse
// shortcut must NOT fire over them: links (middle-click opens a new tab) and
// the settings/menu/volume panels (which contain their own controls). NOTE:
// plain buttons are deliberately NOT excluded — the big play button covers a
// cell's center, and middle/right-clicking it should still fire the shortcut
// (left-clicks are ignored by the dispatcher via e.button === 0).
export const MOUSE_BIND_EXCLUDE = 'a, .mv-vol-popup, #mv-settings-modal, #mv-menu-panel';
export const MOUSE_LABELS = { Mouse0: 'Left Click', Mouse1: 'Middle Click', Mouse2: 'Right Click', Mouse3: 'Mouse Back', Mouse4: 'Mouse Forward' };

// The cell a shortcut should act on: the click target's cell for mouse
// bindings, else whatever cell the pointer is hovering (keyboard bindings).
export function hoveredCell(e) {
    return (e && e.target && e.target.closest && e.target.closest('.mv-cell'))
        || document.querySelector('.mv-cell:hover');
}
export function muteHoveredCell(e) {
    const cell = hoveredCell(e);
    if (cell) toggleAudio(cell.dataset.sceneId);
}
export function oHoveredCell(e) {
    const cell = hoveredCell(e);
    if (cell) incrementO(cell.dataset.sceneId);
}
export function playPauseHoveredCell(e) {
    const cell = hoveredCell(e);
    const v = cell && cell.querySelector('video');
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
}
export function setLoopMarkOnHovered(e, which) {
    const cell = hoveredCell(e);
    const id = cell && cell.dataset.sceneId;
    const video = cell && cell.querySelector('video');
    // Filter/roulette cells swap scenes under the loop, so they don't take one.
    if (!id || !video || filterBackedCells.has(id)) return;
    const loop = setLoopPoint(id, which, effectivePlayhead(video, id), sceneDuration(id, video));
    if (loop) applyLoopState(id, video);
}
// Step the playhead by the current seek step. Works while paused, which is
// the point: pause, walk the playhead onto the frame you want, mark it.
export function nudgeHovered(e, dir) {
    const delta = dir * seekStepFor(e);
    if (isAllCellsSeek(e)) { seekAllCells(delta); return; }
    const cell = hoveredCell(e);
    const id = cell && cell.dataset.sceneId;
    const video = cell && cell.querySelector('video');
    if (!id || !video) return;
    scheduleWheelSeek(id, video, delta);
}
export function clearLoopOnHovered(e) {
    const cell = hoveredCell(e);
    const id = cell && cell.dataset.sceneId;
    const video = cell && cell.querySelector('video');
    if (!id || !getLoop(id)) return;
    clearLoop(id);
    if (video) applyLoopState(id, video);
}

export function normalizeKey(k) {
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar') return 'Space';
    return k.length === 1 ? k.toLowerCase() : k;
}
export const KEY_LABELS = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
export function keyLabel(k) {
    if (!k) return 'Unbound';
    if (MOUSE_LABELS[k]) return MOUSE_LABELS[k];
    if (KEY_LABELS[k]) return KEY_LABELS[k];
    if (k.startsWith('Mouse')) return 'Mouse ' + k.slice(5);
    return k.length === 1 ? k.toUpperCase() : k;
}
// Actions that read the seek modifiers, so a chord using one is meant for
// us rather than for the browser.
export const SEEK_ACTION_IDS = ['seekBack', 'seekForward'];
export function isSeekChord(e, binding) {
    if (!binding || !(isFineSeek(e) || isAllCellsSeek(e))) return false;
    return SEEK_ACTION_IDS.some(id => playerSettings.keybinds[id] === binding);
}
// Fire the action bound to `binding`, if any. Returns true if one ran.
export function runBinding(binding, e) {
    if (!binding) return false;
    for (const action of KEYBIND_ACTIONS) {
        if (playerSettings.keybinds[action.id] === binding) {
            e.preventDefault();
            action.run(e);
            return true;
        }
    }
    return false;
}
// Saved bindings win over the defaults. A default introduced by a NEWER
// version must not steal a key the user already bound to something else, so
// a colliding default is dropped rather than leaving two actions on one key
// (runBinding would silently fire whichever comes first in KEYBIND_ACTIONS).
export function mergeKeybinds(saved = {}) {
    const merged = { ...DEFAULT_KEYBINDS, ...saved };
    const taken = new Set(Object.values(saved).filter(Boolean));
    for (const id of Object.keys(merged)) {
        if (id in saved) continue;
        if (merged[id] && taken.has(merged[id])) merged[id] = '';
    }
    return merged;
}
