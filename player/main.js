import { toggleMuteAll } from './audio.js';
import { closeAllPopups } from './cell.js';
import { IDLE_HIDE_MS, SETTINGS_KEY, STORAGE_KEY } from './constants.js';
import { KEYBIND_ACTIONS, MOUSE_BIND_EXCLUDE, isSeekChord, normalizeKey, runBinding } from './keybinds.js';
import { applyFocusMode, applyJustifiedLayout, toggleFocusMode } from './layout.js';
import { commitLoopDrag, updateLoopDrag } from './loops.js';
import { openMenuPanel } from './menu.js';
import { flushProgressMap, snapshotAllProgress, startProgressSaveLoop } from './progress.js';
import { getQueue, pendingConfigWrites, resolveQueue, resyncFromCache, seedCacheFromConfig } from './queue.js';
import { render } from './render.js';
import { incrementAllO, loadSceneMeta } from './scenes-api.js';
import { commitSeek, queueSeekZone, setActiveSeek, updateSeekFill } from './seek.js';
import { loadPlayerSettings, playerSettings, setPlayerSettings } from './settings.js';
import { keybindCaptureActive, openSettingsModal } from './settings-ui.js';
import { queue, setQueue } from './state.js';
import { applyFullscreenIcon, playPauseAll, toggleFullscreen } from './topbar.js';
import { flushAllTrackers } from './tracking.js';

// Registered from init() once settings are loaded: a resync renders, and
// rendering reads the settings.
function registerSyncListeners() {
    window.addEventListener('pagehide', () => { flushAllTrackers(); snapshotAllProgress(); flushProgressMap(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { flushAllTrackers(); snapshotAllProgress(); flushProgressMap(); }
    });

    // ── Cross-tab sync ─────────────────────────────────────────────────

    // Same-origin cross-tab: the local cache changed in another tab.
    window.addEventListener('storage', e => {
        if (e.key !== STORAGE_KEY) return;
        resyncFromCache();
    });

    // Cross-CLIENT: the queue can change from the Stash scene-list plugin,
    // binge web, or binge-iOS. Poll config while visible (and on becoming
    // visible) and re-resolve only when it actually changed — so the wall
    // tracks the live queue without churning playback. Skips while our own
    // write is in flight so it can't revert it.
    setInterval(async () => {
        if (document.visibilityState !== 'visible' || pendingConfigWrites > 0) return;
        if (await seedCacheFromConfig()) resyncFromCache();
    }, 5000);
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState !== 'visible' || pendingConfigWrites > 0) return;
        if (await seedCacheFromConfig()) resyncFromCache();
    });
}

// ── Idle auto-hide ─────────────────────────────────────────────────────

export let idleHideTimer = null;
export function markPointerActive() {
    document.body.classList.remove('mv-idle');
    clearTimeout(idleHideTimer);
    idleHideTimer = setTimeout(() => document.body.classList.add('mv-idle'), IDLE_HIDE_MS);
}

// ── Init ───────────────────────────────────────────────────────────────

export async function init() {
    const savedSettings = (() => {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
        catch { return {}; }
    })();
    setPlayerSettings(loadPlayerSettings(savedSettings));
    registerSyncListeners();
    applyFocusMode(playerSettings.focusMode);

    // Seed the local cache from the authoritative config before
    // resolving the wall, so the player opens on the live queue.
    await seedCacheFromConfig();
    setQueue(await resolveQueue(getQueue()));
    document.getElementById('mv-playpause-all-btn').addEventListener('click', playPauseAll);
    document.getElementById('mv-mute-all-btn').addEventListener('click', toggleMuteAll);
    document.getElementById('mv-o-all-btn').addEventListener('click', incrementAllO);
    document.getElementById('mv-focus-btn').addEventListener('click', toggleFocusMode);
    document.getElementById('mv-fullscreen-btn').addEventListener('click', toggleFullscreen);
    document.getElementById('mv-settings-btn').addEventListener('click', openSettingsModal);
    document.getElementById('mv-roulette-btn').addEventListener('click', openMenuPanel);
    document.addEventListener('fullscreenchange', applyFullscreenIcon);
    applyFullscreenIcon();
    document.addEventListener('keydown', e => {
        // Let modified chords (Ctrl/Cmd/Alt) and typing in fields pass through,
        // and stand down while a rebind capture is grabbing the next key.
        if (keybindCaptureActive) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        const binding = normalizeKey(e.key);
        // The one exception: a modifier the user has given a seek role,
        // pressed with a key bound to a seek action, is ours. runBinding
        // calls preventDefault, which is also what stops Alt+Left from
        // navigating back. Every other chord still belongs to the browser.
        if ((e.ctrlKey || e.metaKey || e.altKey) && !isSeekChord(e, binding)) return;
        runBinding(binding, e);
    });

    // Mouse-button shortcuts. Never hijack the left button; skip links and
    // controls so they keep their native click. preventDefault on mousedown
    // suppresses the middle-button autoscroll puck (it arms on press).
    // Capture phase so a cell/seekbar stopPropagation can't swallow it.
    document.addEventListener('mousedown', e => {
        if (keybindCaptureActive || e.button === 0) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest(MOUSE_BIND_EXCLUDE)) return;
        runBinding('Mouse' + e.button, e);
    }, true);
    // If the right button is bound, swallow the context menu it would open.
    document.addEventListener('contextmenu', e => {
        if (keybindCaptureActive || e.target.closest(MOUSE_BIND_EXCLUDE)) return;
        const rightBound = KEYBIND_ACTIONS.some(a => playerSettings.keybinds[a.id] === 'Mouse2');
        if (rightBound) e.preventDefault();
    });
    window.addEventListener('resize', () => {
        if (playerSettings.focusMode) applyJustifiedLayout();
    });

    document.addEventListener('mousemove', e => { updateSeekFill(e); updateLoopDrag(e); queueSeekZone(e); });
    document.addEventListener('mouseup', e => {
        commitSeek();
        setActiveSeek(null);
        commitLoopDrag();
        // The drag was holding the zone open; hand it back to the pointer.
        queueSeekZone(e);
    });

    // Idle auto-hide: any pointer/keyboard activity keeps the chrome up and
    // re-arms the hide timer; stillness hides it after IDLE_HIDE_MS.
    ['mousemove', 'mousedown', 'wheel', 'keydown'].forEach(ev =>
        document.addEventListener(ev, markPointerActive, { passive: true }));
    markPointerActive();

    // Close popup when clicking anywhere outside a popup or its trigger button
    document.addEventListener('mousedown', e => {
        if (!e.target.closest('.mv-vol-popup') && !e.target.closest('.mv-cell-audio-btn')) {
            closeAllPopups();
        }
    });

    await loadSceneMeta(queue);
    render();
    startProgressSaveLoop();
}

// index.html inserts this module from a script, and an inserted script does
// not hold up DOMContentLoaded, so the event may already have fired.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
