import { ICON_VOLUME_OFF, ICON_VOLUME_ON } from './icons.js';
import { playerSettings } from './settings.js';
import { queue, unmutedIds } from './state.js';

// ── Web Audio ──────────────────────────────────────────────────────────

export let audioCtx = null;
export const cellGains = new Map(); // id → GainNode

export function getAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Browsers suspend AudioContext until a user gesture; resume eagerly
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

export function connectAudio(id, video) {
    if (cellGains.has(id)) return; // already connected
    try {
        const ctx = getAudioCtx();
        const source = ctx.createMediaElementSource(video);
        const gain = ctx.createGain();
        gain.gain.value = playerSettings.defaultVolume;
        source.connect(gain);
        gain.connect(ctx.destination);
        cellGains.set(id, gain);
    } catch (e) {
        // Silently ignore — audio still works via video.volume fallback
    }
}

export function setGain(id, value) {
    getAudioCtx(); // ensure context is resumed
    const gain = cellGains.get(id);
    if (gain) gain.gain.value = value;
}

export function disconnectAudio(id) {
    const gain = cellGains.get(id);
    if (gain) {
        try { gain.disconnect(); } catch {}
        cellGains.delete(id);
    }
}
// ── Audio mute/unmute ──────────────────────────────────────────────────

export function applyAudioCell(cell) {
    const id = cell.dataset.sceneId;
    const on = unmutedIds.has(id);
    const video = cell.querySelector('video');
    if (video) video.muted = !on;
    cell.classList.toggle('audio-active', on);
    ['.mv-cell-audio-btn', '.mv-popup-mute-btn'].forEach(sel => {
        const btn = cell.querySelector(sel);
        if (!btn) return;
        btn.classList.toggle('audio-on', on);
        btn.innerHTML = on ? ICON_VOLUME_ON : ICON_VOLUME_OFF;
        btn.title = on ? 'Mute' : 'Unmute';
    });
}

export function toggleAudio(id) {
    getAudioCtx(); // resume on any interaction
    if (unmutedIds.has(String(id))) unmutedIds.delete(String(id));
    else unmutedIds.add(String(id));
    const cell = document.querySelector(`.mv-cell[data-scene-id="${id}"]`);
    if (cell) applyAudioCell(cell);
    updateMuteAllBtn();
}

export function updateMuteAllBtn() {
    const btn = document.getElementById('mv-mute-all-btn');
    if (!btn) return;
    const anyUnmuted = unmutedIds.size > 0;
    btn.title = anyUnmuted ? 'Mute All' : 'Unmute All';
    btn.innerHTML = anyUnmuted
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512" aria-hidden="true"><path fill="currentColor" d="M533.6 32.5C598.5 85.2 640 165.8 640 256s-41.5 170.7-106.4 223.5c-10.3 8.4-25.4 6.8-33.8-3.5s-6.8-25.4 3.5-33.8C557.5 398.2 592 331.2 592 256s-34.5-142.2-88.7-186.2c-10.3-8.4-11.8-23.5-3.5-33.8s23.5-11.8 33.8-3.5zM473.1 107c43.2 35.2 70.9 88.9 70.9 149s-27.7 113.8-70.9 149c-10.3 8.4-25.4 6.8-33.8-3.5s-6.8-25.4 3.5-33.8C475.3 341.3 496 301.1 496 256s-20.7-85.3-53.2-111.8c-10.3-8.4-11.8-23.5-3.5-33.8s23.5-11.8 33.8-3.5zm-60.5 74.5C434.1 199.1 448 225.9 448 256s-13.9 56.9-35.4 74.5c-10.3 8.4-25.4 6.8-33.8-3.5s-6.8-25.4 3.5-33.8C393.1 284.4 400 271 400 256s-6.9-28.4-17.7-37.3c-10.3-8.4-11.8-23.5-3.5-33.8s23.5-11.8 33.8-3.5zM301.1 34.8C312.6 40 320 51.4 320 64V448c0 12.6-7.4 24-18.9 29.2s-25 3.1-34.4-5.3L131.8 352H64c-35.3 0-64-28.7-64-64V224c0-35.3 28.7-64 64-64h67.8L266.7 40.1c9.4-8.4 22.9-10.7 34.4-5.3z"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512" aria-hidden="true"><path fill="currentColor" d="M301.1 34.8C312.6 40 320 51.4 320 64V448c0 12.6-7.4 24-18.9 29.2s-25 3.1-34.4-5.3L131.8 352H64c-35.3 0-64-28.7-64-64V224c0-35.3 28.7-64 64-64h67.8L266.7 40.1c9.4-8.4 22.9-10.7 34.4-5.3zM425 167l55 55 55-55c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-55 55 55 55c9.4 9.4 9.4 24.6 0 33.9s-24.6 9.4-33.9 0l-55-55-55 55c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l55-55-55-55c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0z"/></svg>`;
}

export function toggleMuteAll() {
    getAudioCtx();
    if (unmutedIds.size > 0) {
        unmutedIds.clear();
    } else {
        queue.forEach(id => typeof id === 'string' && unmutedIds.add(id));
    }
    document.querySelectorAll('.mv-cell').forEach(applyAudioCell);
    updateMuteAllBtn();
}
