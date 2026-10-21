import { playerSettings } from './settings.js';
import { queue, scenes, seekBases } from './state.js';

// ── Stream URL + playhead helpers ──────────────────────────────────────
// A transcoded stream URL carries a container extension; a direct stream
// (/scene/ID/stream) does not. This decides whether seeking must go through
// ?start= (transcode, where currentTime seeking is unreliable) or can use
// video.currentTime directly (direct stream).
export function isTranscodeUrl(src) {
    return !!src && (src.includes('.webm') || src.includes('.mp4'));
}
// The stream URL with any ?start=/&start= offset stripped off.
export function stripStart(src) {
    return (src || '').split(/[?&]start=/)[0];
}
// Append a start offset to a base URL, choosing ? or & as needed.
export function withStart(baseSrc, t) {
    return baseSrc + (baseSrc.includes('?') ? '&' : '?') + 'start=' + t;
}
// Effective scene playhead: currentTime plus the offset already consumed
// before the current transcode src (?start=), tracked in seekBases.
export function effectivePlayhead(video, id) {
    const src = video.getAttribute('src') || '';
    let t = video.currentTime;
    if (src.match(/[?&]start=/)) t += (seekBases.get(id) || 0);
    return t;
}
// Whole-scene length. The element's own duration is only trustworthy when
// the src covers the whole scene, so Stash's metadata wins where we have it.
export function totalDuration(id, video) {
    return scenes[id]?.duration || (video && isFinite(video.duration) ? video.duration : null);
}
// ── Stream selection ───────────────────────────────────────────────────

export function parseStreams(streamList) {
    const s = {};
    if (!streamList) return s;
    for (const entry of streamList) {
        const label = (entry.label || '').toLowerCase();
        const isWebm = (entry.mime_type || '').includes('webm');

        const is1080 = label.includes('1080');
        const is720 = label.includes('720');
        const is480 = label.includes('480');
        const is360 = label.includes('360') || label.includes('240');

        if (is1080 && isWebm)      s.webm1080 = entry.url;
        else if (is1080)           s.mp41080  = entry.url;
        else if (is720 && isWebm)  s.webm720  = entry.url;
        else if (is720)            s.mp4720   = entry.url;
        else if (is480 && isWebm)  s.webm480  = entry.url;
        else if (is480)            s.mp4480   = entry.url;
        else if (is360 && isWebm)  s.webm360  = entry.url;
        else if (is360)            s.mp4360   = entry.url;
        else if (!s.direct)        s.direct   = entry.url;
    }
    return s;
}
// ── Stream selection ───────────────────────────────────────────────────

export function pickStream(id) {
    const s = scenes[id]?.streams;
    if (!s) return `/scene/${id}/stream`;
    const direct = s.direct || `/scene/${id}/stream`;

    if (playerSettings.directPlay) return direct;

    const count = queue.length;
    const gridKey = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 4 : count <= 6 ? 6 : count <= 9 ? 9 : count <= 12 ? 12 : 16;
    const preferred = playerSettings.quality[gridKey] || 'webm720';

    if (preferred === 'direct') return direct;

    const res = preferred.replace(/^(webm|mp4)/, '');
    return s[preferred] || s['webm' + res] || s['mp4' + res] || direct;
}
