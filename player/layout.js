import { playerSettings, savePlayerSettings } from './settings.js';
import { queue } from './state.js';

export function applyFocusMode(enabled) {
    document.body.classList.toggle('mv-focus', enabled);
    document.getElementById('mv-focus-btn')?.classList.toggle('active', enabled);
    if (enabled) {
        applyJustifiedLayout();
    } else {
        clearJustifiedLayout();
        detectAndApplyOrientation();
    }
}

export function toggleFocusMode() {
    playerSettings.focusMode = !playerSettings.focusMode;
    savePlayerSettings();
    applyFocusMode(playerSettings.focusMode);
}
// ── Layout ─────────────────────────────────────────────────────────────

export function autoLayout(count, isPortrait = false) {
    if (count <= 1) return '1x1';
    if (count <= 2) return '2x1';
    if (isPortrait && count === 3) return '3x1';
    if (count <= 4) return '2x2';
    if (count <= 6) return '3x2';
    if (count <= 9) return '3x3';
    if (count <= 12) return '3x4';
    return '4x4';
}

export function detectAndApplyOrientation() {
    if (playerSettings.focusMode) {
        applyJustifiedLayout();
        return;
    }
    const videos = [...document.querySelectorAll('.mv-cell video')];
    const loaded = videos.filter(v => v.videoWidth > 0 && v.videoHeight > 0);
    if (!loaded.length) return;

    const portraitCount = loaded.filter(v => v.videoHeight > v.videoWidth).length;
    const isPortrait = portraitCount > loaded.length / 2;

    const grid = document.getElementById('mv-grid');
    const expectedLayout = autoLayout(queue.length, isPortrait);
    if (grid && grid.className !== 'layout-' + expectedLayout) {
        grid.className = 'layout-' + expectedLayout;
    }
}

export function computeJustifiedLayout(aspectRatios, containerWidth, containerHeight, gap) {
    const n = aspectRatios.length;
    if (n === 0) return [];

    const snapped = aspectRatios.map(a => a >= 1 ? 16 / 9 : 9 / 16);
    const totalAspectSum = snapped.reduce((s, a) => s + a, 0);

    const numRows = Math.max(1, Math.round(Math.sqrt(totalAspectSum * containerHeight / containerWidth)));
    const targetPerRow = totalAspectSum / numRows;

    const rows = [];
    let cur = { start: 0, end: 0, aspectSum: 0 };
    for (let i = 0; i < n; i++) {
        const withItem = cur.aspectSum + snapped[i];
        if (rows.length < numRows - 1 && cur.end > cur.start &&
            withItem - targetPerRow > targetPerRow - cur.aspectSum) {
            rows.push(cur);
            cur = { start: i, end: i, aspectSum: 0 };
        }
        cur.aspectSum += snapped[i];
        cur.end = i + 1;
    }
    rows.push(cur);

    rows.forEach(row => {
        row.naturalH = (containerWidth - gap * (row.end - row.start - 1)) / row.aspectSum;
    });
    const totalNaturalH = rows.reduce((s, row) => s + row.naturalH, 0) + gap * (rows.length - 1);
    const scale = containerHeight / totalNaturalH;

    const positions = [];
    let top = 0;
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const rowH = Math.round(row.naturalH * scale);
        if (r > 0) top += gap;
        let left = 0;
        for (let i = row.start; i < row.end; i++) {
            const w = i === row.end - 1
                ? containerWidth - Math.round(left)
                : Math.round(snapped[i] * row.naturalH);
            positions.push({ left: Math.round(left), top, width: w, height: rowH });
            left += w + gap;
        }
        top += rowH;
    }
    return positions;
}

// Mixed-orientation focus layout. Portrait cells stand a full band tall;
// landscape cells pair up and stack two-high to fill the same band, so a
// portrait reads as exactly double the height of the landscapes beside it.
// Like computeJustifiedLayout, each band fills width via its natural height
// and fills container height via a uniform vertical scale (object-fit:cover
// hides the box distortion), so the result stays edge-to-edge — no ragged
// bottom. Returns one position per original cell index.
export function computeBandedLayout(aspectRatios, containerWidth, containerHeight, gap) {
    const n = aspectRatios.length;
    if (n === 0) return [];
    const LAND = 16 / 9, PORT = 9 / 16;

    // Walk cells in order, grouping them into "slots". A slot occupies one
    // full band height and is one of:
    //   portrait        → aspect PORT,    one cell at full band height
    //   landscape pair  → aspect LAND/2,  two cells stacked (top + bottom)
    //   landscape lone  → aspect LAND,    one cell at full band height
    //     (an unpaired trailing landscape — promoted to full height so it
    //      never leaves an empty bottom half)
    const slots = [];
    let pendingPair = null; // landscape slot still waiting for its bottom cell
    for (let i = 0; i < n; i++) {
        if (aspectRatios[i] < 1) {
            slots.push({ aspect: PORT, items: [{ idx: i, pos: 'full' }] });
        } else if (pendingPair) {
            pendingPair.items.push({ idx: i, pos: 'bottom' });
            pendingPair = null;
        } else {
            const slot = { aspect: LAND / 2, items: [{ idx: i, pos: 'top' }] };
            slots.push(slot);
            pendingPair = slot;
        }
    }
    if (pendingPair) { // lone trailing landscape → full-height single
        pendingPair.aspect = LAND;
        pendingPair.items[0].pos = 'full';
    }

    // Pack slots into bands exactly as computeJustifiedLayout packs cells
    // into rows, using each slot's aspect.
    const snapped = slots.map(s => s.aspect);
    const totalAspectSum = snapped.reduce((s, a) => s + a, 0);
    const numBands = Math.max(1, Math.round(Math.sqrt(totalAspectSum * containerHeight / containerWidth)));
    const targetPerBand = totalAspectSum / numBands;

    const bands = [];
    let cur = { start: 0, end: 0, aspectSum: 0 };
    for (let i = 0; i < slots.length; i++) {
        const withItem = cur.aspectSum + snapped[i];
        if (bands.length < numBands - 1 && cur.end > cur.start &&
            withItem - targetPerBand > targetPerBand - cur.aspectSum) {
            bands.push(cur);
            cur = { start: i, end: i, aspectSum: 0 };
        }
        cur.aspectSum += snapped[i];
        cur.end = i + 1;
    }
    bands.push(cur);

    bands.forEach(band => {
        band.naturalH = (containerWidth - gap * (band.end - band.start - 1)) / band.aspectSum;
    });
    const totalNaturalH = bands.reduce((s, band) => s + band.naturalH, 0) + gap * (bands.length - 1);
    const scale = containerHeight / totalNaturalH;

    const positions = new Array(n);
    let top = 0;
    for (let r = 0; r < bands.length; r++) {
        const band = bands[r];
        const bandH = Math.round(band.naturalH * scale);
        if (r > 0) top += gap;
        let left = 0;
        for (let si = band.start; si < band.end; si++) {
            const slot = slots[si];
            const w = si === band.end - 1
                ? containerWidth - Math.round(left)
                : Math.round(slot.aspect * band.naturalH);
            const x = Math.round(left);
            const halfH = Math.round((bandH - gap) / 2);
            for (const item of slot.items) {
                if (item.pos === 'top') {
                    positions[item.idx] = { left: x, top, width: w, height: halfH };
                } else if (item.pos === 'bottom') {
                    positions[item.idx] = { left: x, top: top + bandH - halfH, width: w, height: halfH };
                } else { // full
                    positions[item.idx] = { left: x, top, width: w, height: bandH };
                }
            }
            left += w + gap;
        }
        top += bandH;
    }
    return positions;
}

export function applyJustifiedLayout() {
    if (!playerSettings.focusMode) return;
    const grid = document.getElementById('mv-grid');
    if (!grid) return;
    const cells = [...grid.querySelectorAll('.mv-cell')];
    if (cells.length === 0) return;
    const containerWidth  = grid.clientWidth;
    const containerHeight = grid.clientHeight;
    if (containerWidth === 0 || containerHeight === 0) return;
    const GAP = 3;
    const aspectRatios = cells.map(cell => {
        const video = cell.querySelector('video');
        return (video && video.videoWidth > 0 && video.videoHeight > 0)
            ? video.videoWidth / video.videoHeight
            : 16 / 9;
    });
    // Mixed grids (portrait + landscape together) use the banded layout so
    // portraits stand double the height of the landscapes; uniform grids
    // (all one orientation) keep the plain justified rows.
    const hasPortrait  = aspectRatios.some(a => a < 1);
    const hasLandscape = aspectRatios.some(a => a >= 1);
    const positions = (hasPortrait && hasLandscape)
        ? computeBandedLayout(aspectRatios, containerWidth, containerHeight, GAP)
        : computeJustifiedLayout(aspectRatios, containerWidth, containerHeight, GAP);
    cells.forEach((cell, i) => {
        const p = positions[i];
        if (!p) return;
        cell.style.left   = p.left   + 'px';
        cell.style.top    = p.top    + 'px';
        cell.style.width  = p.width  + 'px';
        cell.style.height = p.height + 'px';
    });
}

export function clearJustifiedLayout() {
    document.querySelectorAll('.mv-cell').forEach(cell => {
        cell.style.left = cell.style.top = cell.style.width = cell.style.height = '';
    });
}
