import { ICON_COMPRESS, ICON_EXPAND } from './icons.js';

export function applyFullscreenIcon() {
    const fs = !!document.fullscreenElement;
    const btn = document.getElementById('mv-fullscreen-btn');
    if (!btn) return;
    btn.innerHTML = fs ? ICON_COMPRESS : ICON_EXPAND;
    btn.title = fs ? 'Exit Full Screen' : 'Full Screen';
    btn.classList.toggle('active', fs);
}

export function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen?.();
    } else {
        document.documentElement.requestFullscreen?.().catch(() => {});
    }
}
// ── Play / Pause All ───────────────────────────────────────────────────

export function playPauseAll() {
    const videos = [...document.querySelectorAll('.mv-cell video')];
    const anyPlaying = videos.some(v => !v.paused);
    videos.forEach(v => anyPlaying ? v.pause() : v.play().catch(() => {}));
    // Each video's own 'play'/'pause' listener calls refreshPlayPauseAllBtn,
    // but call it here too so the icon updates even if the grid is empty.
    refreshPlayPauseAllBtn();
}

// Keeps the "Play/Pause All" icon in sync with actual per-video state,
// which drifts from it any time a video starts/stops outside this
// button (scene pause button, new scene added to the queue, etc.)
export function refreshPlayPauseAllBtn() {
    const videos = [...document.querySelectorAll('.mv-cell video')];
    updatePlayPauseAllBtn(videos.some(v => !v.paused));
}

export function updatePlayPauseAllBtn(playing) {
    const btn = document.getElementById('mv-playpause-all-btn');
    if (!btn) return;
    btn.innerHTML = playing
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512" aria-hidden="true"><path fill="currentColor" d="M48 64C21.5 64 0 85.5 0 112V400c0 26.5 21.5 48 48 48H80c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H48zm192 0c-26.5 0-48 21.5-48 48V400c0 26.5 21.5 48 48 48h32c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H240z"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" aria-hidden="true"><path fill="currentColor" d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80V432c0 17.4 9.4 33.4 24.5 41.9S58.2 482 73 473l288-176c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/></svg>`;
    btn.title = playing ? 'Pause All' : 'Play All';
}
