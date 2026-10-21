import { SETTINGS_KEY } from './constants.js';
import { mergeKeybinds } from './keybinds.js';
import { SEEK_MODIFIERS, SEEK_STEP_MAX } from './seek.js';

// ── Settings ───────────────────────────────────────────────────────────

export const QUALITY_OPTIONS = [
    { value: 'direct',   label: 'Direct Stream' },
    { value: 'webm1080', label: '1080p (WebM)' },
    { value: 'webm720',  label: '720p (WebM)'  },
    { value: 'webm480',  label: '480p (WebM)'  },
    { value: 'webm360',  label: '360p (WebM)'  },
    { value: 'mp41080',  label: '1080p (MP4)'  },
    { value: 'mp4720',   label: '720p (MP4)'   },
    { value: 'mp4480',   label: '480p (MP4)'   },
    { value: 'mp4360',   label: '360p (MP4)'   },
];

export const GRID_ROWS = [
    { key: 1,  label: '1 video'   },
    { key: 2,  label: '2 videos'  },
    { key: 4,  label: '4 videos'  },
    { key: 6,  label: '6 videos'  },
    { key: 9,  label: '9 videos'  },
    { key: 12, label: '12 videos' },
    { key: 16, label: '16 videos' },
];

export const DEFAULT_QUALITY = { 1: 'webm1080', 2: 'webm720', 4: 'webm720', 6: 'webm480', 9: 'webm480', 12: 'webm360', 16: 'webm360' };
export function loadPlayerSettings(saved = {}) {
    return {
        directPlay: saved.directPlay ?? false,
        quality: { ...DEFAULT_QUALITY, ...(saved.quality || {}) },
        focusMode: saved.focusMode ?? false,
        wheelSeek: saved.wheelSeek ?? false,
        invertWheelSeek: saved.invertWheelSeek ?? false,
        // Initial gain applied to every cell (0–2 → 0–200%). sashi: 100% is
        // too loud by default, so this is user-tunable. Cells still start
        // muted; this is the level the gain jumps to when first unmuted.
        defaultVolume: Math.max(0, Math.min(2, saved.defaultVolume ?? 1.0)),
        // Seek steps shared by the wheel and the nudge shortcuts.
        seekStep: clampStep(saved.seekStep, 5),
        seekStepFine: clampStep(saved.seekStepFine, 1),
        fineModifier: pickModifier(saved.fineModifier, 'shift'),
        // Alt rather than Ctrl by default; Ctrl+wheel is browser zoom.
        allCellsModifier: pickModifier(saved.allCellsModifier, 'alt'),
        keybinds: mergeKeybinds(saved.keybinds || {})
    };
}

export function clampStep(v, fallback) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.min(SEEK_STEP_MAX, n) : fallback;
}
export function pickModifier(v, fallback) {
    return SEEK_MODIFIERS.some(m => m.value === v) ? v : fallback;
}

// Set by init() before anything reads it. Not built here at import time:
// the defaults come from keybinds.js and seek.js, which a circular import
// may not have evaluated yet.
export let playerSettings = null;

export function savePlayerSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(playerSettings));
}

export function setPlayerSettings(next) { playerSettings = next; }
