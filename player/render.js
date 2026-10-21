import { disconnectAudio } from './audio.js';
import { createCell, destroyCell } from './cell.js';
import { STREAM_STAGGER_MS } from './constants.js';
import { autoLayout, detectAndApplyOrientation } from './layout.js';
import { syncNativeLoop } from './loops.js';
import { filterBackedCells, queue, seekBases } from './state.js';
import { effectivePlayhead, isTranscodeUrl, pickStream, stripStart, withStart } from './stream.js';
import { refreshPlayPauseAllBtn } from './topbar.js';
import { showSpinner } from './ui.js';

// ── Render ─────────────────────────────────────────────────────────────

export function render() {
    const grid = document.getElementById('mv-grid');
    const empty = document.getElementById('mv-empty');
    const titleEl = document.getElementById('mv-title');

    if (queue.length === 0) {
        // Tear each cell down, as the pass below does: clearing the grid's
        // HTML would leave play tracking unflushed and each scene's gain
        // registered, so a scene that came back later had a dead volume.
        for (const cell of Array.from(grid.children)) {
            if (cell.dataset.sceneId) disconnectAudio(cell.dataset.sceneId);
            destroyCell(cell);
        }
        grid.className = 'layout-1x1';
        empty.style.display = 'flex';
        titleEl.textContent = 'Stash Multiview';
        return;
    }

    empty.style.display = 'none';
    titleEl.textContent = `${queue.length} scene${queue.length > 1 ? 's' : ''}`;

    const layout = autoLayout(queue.length);
    grid.className = 'layout-' + layout;
    // Correct layout immediately if videos already have dimensions (re-render case)
    detectAndApplyOrientation();

    // Snapshot existing cells so add/cleanup use O(1) Map/Set lookups
    // instead of N querySelector + N queue.includes (O(N^2)). Newly
    // created cells sit at lower indices than the iterator, so the
    // refCell forward-search never needs to see them.
    const existing = new Map();
    for (const cell of grid.children) {
        const cid = cell.dataset.sceneId;
        if (cid && !existing.has(cid)) existing.set(cid, cell); // canonical = first cell per id
    }
    // A cell is wired as either a pinned or a filter cell when it is built
    // (looping, `ended` handling, label, loop controls), so one whose scene
    // has switched kind, e.g. pinned by hand while a filter cell was
    // showing it, is rebuilt rather than reused. Dropping it from
    // `existing` makes the pass below create a fresh cell and the cleanup
    // pass tear this one down. Its gain goes too, or connectAudio would
    // skip the new video and leave its volume control dead.
    for (const [cid, cell] of existing) {
        if (cell.classList.contains('mv-cell--filter') !== filterBackedCells.has(cid)) {
            existing.delete(cid);
            disconnectAudio(cid);
        }
    }
    const queueSet = new Set(queue);

    // Add new cells at their correct queue position (before removal to avoid layout flash)
    let newCellOrdinal = 0; // counts only cells created this pass, for stream stagger
    queue.forEach((id, idx) => {
        if (typeof id !== 'string') return;
        if (existing.has(id)) return;

        const { cell, start } = createCell(id);
        const staggerSlot = newCellOrdinal++;

        // Insert at correct queue position instead of appending to end
        let refCell = null;
        for (let i = idx + 1; i < queue.length; i++) {
            const nextId = queue[i];
            if (typeof nextId !== 'string') continue;
            const next = existing.get(nextId);
            if (next) { refCell = next; break; }
        }
        grid.insertBefore(cell, refCell);
        // Register the new cell so a duplicate of this id later in the same
        // queue (two filter slots resolving to the same scene, etc.) is
        // skipped instead of spawning a second cell with the same id.
        existing.set(id, cell);

        // Start the stream, staggered. The cell is in the DOM and fully
        // wired by now; start() skips a cell torn down during its delay.
        const startDelay = staggerSlot * STREAM_STAGGER_MS;
        if (startDelay > 0) setTimeout(start, startDelay);
        else start();
    });

    // Remove cells no longer in queue. Walk the real DOM (not the id-keyed
    // `existing` map) so any stray duplicate-id cell is also torn down and
    // can't leak its <video>/watchdog. Keep only the canonical cell per id.
    for (const cell of Array.from(grid.children)) {
        const cid = cell.dataset.sceneId;
        if (cid && queueSet.has(cid) && existing.get(cid) === cell) continue;
        // Gains are keyed by scene id and connectAudio skips ids it already
        // has, so a stale entry would leave this scene's volume control
        // driving a dead node if it ever returns to the grid.
        if (cid && !queueSet.has(cid)) disconnectAudio(cid);
        destroyCell(cell);
    }

    refreshPlayPauseAllBtn();
    // Re-run layout now that removed cells are actually gone, so the
    // remaining ones expand to fill the gaps instead of leaving them.
    detectAndApplyOrientation();
}

export function applyQualityToAllCells() {
    document.querySelectorAll('.mv-cell').forEach(cell => {
        const id = cell.dataset.sceneId;
        const video = cell.querySelector('video');
        if (!video) return;

        const optimalSrc = pickStream(id);
        const currentSrc = video.getAttribute('src') || '';
        const baseSrc = stripStart(currentSrc);

        if (!baseSrc || baseSrc === optimalSrc) return;

        const currentTime = effectivePlayhead(video, id);
        const wasPlaying = !video.paused;
        const isTranscode = isTranscodeUrl(optimalSrc);

        showSpinner(cell);

        if (isTranscode && currentTime > 0) {
            seekBases.set(id, currentTime);
            video.src = withStart(optimalSrc, currentTime);
        } else {
            seekBases.set(id, 0);
            video.src = optimalSrc;
            const onMeta = () => {
                if (currentTime > 0) video.currentTime = currentTime;
                video.removeEventListener('loadedmetadata', onMeta);
            };
            video.addEventListener('loadedmetadata', onMeta);
        }
        syncNativeLoop(id, video);
        if (wasPlaying || video.autoplay) video.play().catch(() => {});
    });
}
