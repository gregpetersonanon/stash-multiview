import { connectAudio, disconnectAudio, getAudioCtx, setGain, toggleAudio } from './audio.js';
import { LOOP_EPSILON, MAX_RECOVERIES, PROGRESS_END_MARGIN, RECOVERY_COOLDOWN_MS, SEEKING_SPINNER_DELAY_MS, STALL_TIMEOUT_MS, STREAM_STAGGER_MS, SUSTAINED_PLAY_MS } from './constants.js';
import { ICON_LOOP, ICON_NEXT, ICON_PAUSE, ICON_PLAY, ICON_PREV, ICON_REMOVE, ICON_SWEAT, ICON_VOLUME_OFF, ICON_VOLUME_ON } from './icons.js';
import { autoLayout, detectAndApplyOrientation } from './layout.js';
import { activeLoopDrag, cycleLoopButton, getLoop, jumpToLoopStart, sceneDuration, seatFullSceneAfterPartialPass, setActiveLoopDrag, syncNativeLoop } from './loops.js';
import { clearResumeTime, getResumeTime } from './progress.js';
import { advanceFilterCell, removeScene } from './queue.js';
import { incrementO } from './scenes-api.js';
import { activeSeek, commitSeek, isAllCellsSeek, isFineSeek, paintSeekTime, scheduleWheelSeek, seekAllCells, seekStepFor, seekToStart, setActiveSeek, wheelPending } from './seek.js';
import { playerSettings } from './settings.js';
import { filterBackedCells, queue, scenes, seekBases, unmutedIds } from './state.js';
import { effectivePlayhead, isTranscodeUrl, pickStream, stripStart, totalDuration, withStart } from './stream.js';
import { refreshPlayPauseAllBtn } from './topbar.js';
import { setupPlayTracking, teardownPlayTracking } from './tracking.js';
import { fmtTime, hideSpinner, showSpinner } from './ui.js';

export let openPopupId = null;
// ── Volume popup ───────────────────────────────────────────────────────

export function closeAllPopups() {
    openPopupId = null;
    document.querySelectorAll('.mv-cell.mv-popup-open').forEach(cell => {
        cell.classList.remove('mv-popup-open');
        const p = cell.querySelector('.mv-vol-popup');
        if (p) p.classList.remove('is-open');
    });
}

export function togglePopup(id) {
    if (openPopupId === id) { closeAllPopups(); return; }
    closeAllPopups();
    openPopupId = id;
    const cell = document.querySelector(`.mv-cell[data-scene-id="${id}"]`);
    if (!cell) return;
    cell.classList.add('mv-popup-open');
    const p = cell.querySelector('.mv-vol-popup');
    if (p) p.classList.add('is-open');
}

// ── Render ─────────────────────────────────────────────────────────────

export function render() {
    const grid = document.getElementById('mv-grid');
    const empty = document.getElementById('mv-empty');
    const titleEl = document.getElementById('mv-title');

    if (queue.length === 0) {
        grid.innerHTML = '';
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

        const staggerSlot = newCellOrdinal++;
        const cell = document.createElement('div');
        const isFilterBacked = filterBackedCells.has(id);
        cell.className = 'mv-cell' + (isFilterBacked ? ' mv-cell--filter' : '');
        cell.dataset.sceneId = id;

        const video = document.createElement('video');
        const baseSrc = pickStream(id);
        // A looped scene opens at A instead of wherever it was left off:
        // inside a loop, "where I left off" has no meaning.
        const cellLoop = isFilterBacked ? null : getLoop(id);
        let resumeTime = cellLoop ? cellLoop.a : (isFilterBacked ? 0 : getResumeTime(id));
        const dur = scenes[id]?.duration;
        if (!cellLoop && resumeTime > 0 && dur && resumeTime > dur - PROGRESS_END_MARGIN) {
            // Stale/at-or-past-end offset (scene re-encoded shorter, or saved
            // right at the end). Start fresh rather than ?start= past EOF.
            resumeTime = 0;
            clearResumeTime(id);
        }
        const isTranscodeSrc = isTranscodeUrl(baseSrc);
        // A transcode resumed via ?start= only contains [resumeTime, end], so
        // native loop would replay just that tail forever. Start it unlooped
        // and re-seat to the full scene when the first partial pass ends.
        const resumedTranscode = resumeTime > 0 && isTranscodeSrc && !isFilterBacked && !cellLoop;
        // Assigning src kicks off the load/transcode. Deferred + staggered
        // (invoked from the staggered start below) so a full grid doesn't
        // fire every transcode request at the same instant.
        const applyInitialSrc = () => {
            if (resumeTime > 0 && isTranscodeSrc) {
                // Transcode resume is reliable via ?start=; currentTime seeking
                // on a live transcode is not.
                seekBases.set(id, resumeTime);
                video.src = withStart(baseSrc, resumeTime);
            } else {
                video.src = baseSrc;
                if (resumeTime > 0) {
                    video.addEventListener('loadedmetadata', () => {
                        try { video.currentTime = resumeTime; } catch {}
                    }, { once: true });
                }
            }
        };
        video.autoplay = true;
        // A cell with an A/B loop drives its own restarts (native loop goes
        // back to 0, not to A), so native looping stays off while one is set.
        video.loop = !isFilterBacked && !resumedTranscode && !cellLoop;
        if (resumedTranscode) seatFullSceneAfterPartialPass(id, video, baseSrc);
        video.muted = !unmutedIds.has(id);
        video.playsInline = true;
        video.disablePictureInPicture = true;

        if (isFilterBacked) {
            video.addEventListener('ended', () => advanceFilterCell(id));
        }

        // ── Stall recovery (loop-proof) ──────────────────────────────
        // Re-source a stalled/errored stream from the effective playhead,
        // bounded so a flaky/dead stream can't hammer the shared transcoder
        // or strobe the grid:
        //  - cooldown between attempts (a pending attempt is deferred, not
        //    dropped, so a dead stream that emits no further events still
        //    gets retried);
        //  - MAX_RECOVERIES budget that is FORGIVEN one at a time only after
        //    an *uninterrupted* healthy window — a stall before the window
        //    completes forfeits the forgiveness, so a tight stall loop walks
        //    the budget up to the cap instead of resetting it every cycle;
        //  - once the budget is exhausted we give up (gaveUp): filter cells
        //    advance to another scene, fixed cells stop, and no further
        //    event re-enters recovery.
        let stallWatchdog = null;
        let recoveryCount = 0;
        let lastRecoveryAt = 0;
        let sustainedPlayTimer = null;
        let cellTornDown = false;
        let gaveUp = false;
        const clearStallWatchdog = () => {
            if (stallWatchdog) { clearTimeout(stallWatchdog); stallWatchdog = null; }
        };
        const recoverVideo = () => {
            if (cellTornDown || gaveUp) return;
            clearStallWatchdog();
            const now = performance.now();
            const sinceLast = now - lastRecoveryAt;
            if (lastRecoveryAt > 0 && sinceLast < RECOVERY_COOLDOWN_MS) {
                // Still cooling down. Don't drop this attempt — a dead
                // stream often emits no further `waiting`/`error`, so we
                // must re-arm the retry ourselves once the cooldown elapses.
                stallWatchdog = setTimeout(recoverVideo, RECOVERY_COOLDOWN_MS - sinceLast);
                return;
            }
            if (recoveryCount >= MAX_RECOVERIES) {
                // Out of budget. Stop hammering the transcoder and don't
                // re-enter on subsequent events. Filter cells advance to a
                // different scene (a fresh cell with a fresh budget); fixed
                // cells just stop on the last frame.
                gaveUp = true;
                if (isFilterBacked) advanceFilterCell(id);
                return;
            }
            recoveryCount++;
            lastRecoveryAt = now;
            const currentSrc = video.getAttribute('src') || '';
            let t = effectivePlayhead(video, id);
            const dur = totalDuration(id, video);
            if (dur && t > dur - 0.5) t = Math.max(0, dur - 0.5); // never re-source past EOF
            if (isTranscodeUrl(currentSrc)) {
                seekBases.set(id, t);
                video.src = withStart(stripStart(currentSrc), t);
                syncNativeLoop(id, video);
            } else {
                video.load();
                video.addEventListener('loadedmetadata', () => {
                    try { video.currentTime = t; } catch {}
                }, { once: true });
            }
            video.play().catch(() => {});
        };
        video.addEventListener('waiting', () => {
            if (gaveUp) return;
            clearStallWatchdog();
            // A stall forfeits the in-progress healthy window so a tight
            // stall loop can never earn budget back (see `playing`).
            clearTimeout(sustainedPlayTimer);
            stallWatchdog = setTimeout(recoverVideo, STALL_TIMEOUT_MS);
        });
        video.addEventListener('playing', () => {
            clearStallWatchdog();
            // Forgive ONE past recovery per uninterrupted healthy window, so
            // a stream that recovers and then plays well isn't stuck near the
            // cap — but `waiting` cancels this timer, so a stream that keeps
            // stalling before the window completes never refills its budget.
            clearTimeout(sustainedPlayTimer);
            sustainedPlayTimer = setTimeout(() => {
                recoveryCount = Math.max(0, recoveryCount - 1);
            }, SUSTAINED_PLAY_MS);
        });
        video.addEventListener('error', recoverVideo);
        video._mvCleanup = () => {
            cellTornDown = true;
            clearStallWatchdog();
            clearTimeout(sustainedPlayTimer);
            clearTimeout(seekingSpinnerTimer); // declared below in the same cell scope; only ever called on a later render's teardown
            // Cancel any queued wheel-seek so it can't fire applyWheelSeek on
            // this now-detached video and resurrect a seekBases entry.
            const pw = wheelPending.get(id);
            if (pw) { clearTimeout(pw.timeout); wheelPending.delete(id); }
            try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
        };

        video.addEventListener('loadedmetadata', () => {
            connectAudio(id, video);
            detectAndApplyOrientation();
        }, { once: true });

        setupPlayTracking(id, video);

        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'mv-loading';
        loadingDiv.innerHTML = '<div class="mv-spinner"></div>';
        video.addEventListener('canplay', () => {
            loadingDiv.remove();
            detectAndApplyOrientation();
        }, { once: true });

        // Final fallback: videoWidth/videoHeight are guaranteed non-zero during playback
        const checkDims = () => {
            if (video.videoWidth > 0) {
                video.removeEventListener('timeupdate', checkDims);
                detectAndApplyOrientation();
            }
        };
        video.addEventListener('timeupdate', checkDims);

        const overlay = document.createElement('div');
        overlay.className = 'mv-cell-overlay';

        const sceneTitleEl = document.createElement('a');
        sceneTitleEl.className = 'mv-cell-title';
        sceneTitleEl.href = `/scenes/${id}`;
        sceneTitleEl.target = '_blank';
        sceneTitleEl.rel = 'noopener';
        if (isFilterBacked) {
            const hasConstraints = Object.keys(filterBackedCells.get(id)?.filter || {}).length > 0;
            const label = document.createElement('span');
            label.className = 'mv-filter-label';
            label.textContent = hasConstraints ? 'Filter: ' : 'Random: ';
            sceneTitleEl.appendChild(label);
            sceneTitleEl.appendChild(document.createTextNode(scenes[id]?.title || id));
        } else {
            sceneTitleEl.textContent = scenes[id]?.title || id;
        }
        sceneTitleEl.addEventListener('click', e => e.stopPropagation());

        // Controls row
        const controls = document.createElement('div');
        controls.className = 'mv-cell-controls';

        const audioBtn = document.createElement('button');
        audioBtn.className = 'mv-cell-btn mv-cell-audio-btn' + (unmutedIds.has(id) ? ' audio-on' : '');
        audioBtn.innerHTML = unmutedIds.has(id) ? ICON_VOLUME_ON : ICON_VOLUME_OFF;
        audioBtn.title = 'Volume';
        audioBtn.addEventListener('click', e => {
            e.stopPropagation();
            getAudioCtx();
            togglePopup(id);
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'mv-cell-btn mv-cell-remove';
        removeBtn.innerHTML = ICON_REMOVE;
        removeBtn.title = 'Remove';
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeScene(id);
        });

        const playPauseBtn = document.createElement('button');
        playPauseBtn.className = 'mv-cell-playpause';
        playPauseBtn.innerHTML = ICON_PAUSE;
        playPauseBtn.title = 'Pause';
        playPauseBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (video.paused) { video.play().catch(() => {}); }
            else              { video.pause(); }
        });
        video.addEventListener('pause', () => {
            playPauseBtn.innerHTML = ICON_PLAY;
            playPauseBtn.title = 'Play';
            refreshPlayPauseAllBtn();
        });
        video.addEventListener('play', () => {
            playPauseBtn.innerHTML = ICON_PAUSE;
            playPauseBtn.title = 'Pause';
            refreshPlayPauseAllBtn();
        });

        const oBtn = document.createElement('button');
        oBtn.className = 'mv-cell-btn mv-o-btn';
        oBtn.title = 'Increment O counter';
        const oCount = scenes[id]?.oCount ?? 0;
        oBtn.innerHTML = `${ICON_SWEAT}<span>${oCount}</span>`;
        oBtn.addEventListener('click', e => {
            e.stopPropagation();
            incrementO(id);
        });

        // A/B loop: badge (bottom-left of the overlay) plus a button that
        // cycles A -> B -> off. Filter cells get neither, their scene changes.
        const loopBadge = document.createElement('span');
        loopBadge.className = 'mv-loop-badge';
        loopBadge.innerHTML = ICON_LOOP + '<span class="mv-loop-badge-text"></span>';
        const loopBadgeText = loopBadge.querySelector('.mv-loop-badge-text');

        const loopBtn = document.createElement('button');
        loopBtn.className = 'mv-cell-btn mv-cell-loop-btn';
        loopBtn.innerHTML = ICON_LOOP;
        loopBtn.addEventListener('click', e => {
            e.stopPropagation();
            cycleLoopButton(id, video);
        });

        const prevBtn = document.createElement('button');
        prevBtn.className = 'mv-cell-skip-btn mv-cell-prev';
        prevBtn.innerHTML = ICON_PREV;
        prevBtn.title = 'Restart video';
        prevBtn.addEventListener('click', e => {
            e.stopPropagation();
            seekToStart(id, video);
        });

        const nextBtn = document.createElement('button');
        nextBtn.className = 'mv-cell-skip-btn mv-cell-next';
        nextBtn.innerHTML = ICON_NEXT;
        nextBtn.title = isFilterBacked ? 'Next video' : 'Restart video';
        nextBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (isFilterBacked) advanceFilterCell(id);
            else seekToStart(id, video);
        });

        const centerControls = document.createElement('div');
        centerControls.className = 'mv-cell-center-controls';
        centerControls.append(prevBtn, playPauseBtn, nextBtn);

        if (isFilterBacked) controls.append(oBtn, audioBtn, removeBtn);
        else                controls.append(loopBadge, oBtn, loopBtn, audioBtn, removeBtn);
        overlay.append(sceneTitleEl, centerControls, controls);

        // Volume popup (direct child of cell, not overlay)
        const popup = document.createElement('div');
        popup.className = 'mv-vol-popup';

        const volLabel = document.createElement('span');
        volLabel.className = 'mv-vol-label';
        volLabel.textContent = Math.round(playerSettings.defaultVolume * 100) + '%';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'mv-vol-slider';
        slider.min = 0;
        slider.max = 2;
        slider.step = 0.05;
        slider.value = playerSettings.defaultVolume;
        slider.title = 'Volume (0-200%)';
        slider.addEventListener('input', e => {
            e.stopPropagation();
            const val = parseFloat(slider.value);
            volLabel.textContent = Math.round(val * 100) + '%';
            setGain(id, val);
        });
        slider.addEventListener('click', e => e.stopPropagation());
        slider.addEventListener('mousedown', e => e.stopPropagation());

        const popupMuteBtn = document.createElement('button');
        popupMuteBtn.className = 'mv-popup-mute-btn mv-cell-btn' + (unmutedIds.has(id) ? ' audio-on' : '');
        popupMuteBtn.innerHTML = unmutedIds.has(id) ? ICON_VOLUME_ON : ICON_VOLUME_OFF;
        popupMuteBtn.title = unmutedIds.has(id) ? 'Mute' : 'Unmute';
        popupMuteBtn.addEventListener('click', e => {
            e.stopPropagation();
            toggleAudio(id);
        });
        popupMuteBtn.addEventListener('mousedown', e => e.stopPropagation());

        popup.append(volLabel, slider, popupMuteBtn);

        // Seekbar
        const seekbar = document.createElement('div');
        seekbar.className = 'mv-seekbar';
        const seekFill = document.createElement('div');
        seekFill.className = 'mv-seekbar-fill';
        seekbar.appendChild(seekFill);

        // Time under the pointer, filled in by the seek-zone painter.
        const seekTime = document.createElement('span');
        seekTime.className = 'mv-seek-time';
        seekbar.appendChild(seekTime);

        // Loop range drawn over the track, with a draggable mark at each end.
        const loopRegion = document.createElement('div');
        loopRegion.className = 'mv-loop-region';
        const loopFill = document.createElement('div');
        loopFill.className = 'mv-loop-progress';
        loopRegion.appendChild(loopFill);
        const handleA = document.createElement('span');
        handleA.className = 'mv-loop-handle is-a';
        const handleB = document.createElement('span');
        handleB.className = 'mv-loop-handle is-b';
        loopRegion.append(handleA, handleB);
        seekbar.appendChild(loopRegion);

        // How far through the loop we are, as a fraction of the band.
        const paintLoopProgress = (l) => {
            if (!l) return;
            const span = l.b - l.a;
            const frac = span > 0 ? (effectivePlayhead(video, id) - l.a) / span : 0;
            loopFill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, frac)) + ')';
        };

        // Repaint the loop chrome. `preview` overrides the stored loop while
        // a mark is being dragged.
        const syncLoop = (preview) => {
            const l = preview || (isFilterBacked ? null : getLoop(id));
            cell.classList.toggle('mv-looping', !!l);
            const duration = sceneDuration(id, video);
            if (l && duration) {
                loopRegion.style.display = 'block';
                loopRegion.style.left = (100 * Math.max(0, Math.min(1, l.a / duration))) + '%';
                loopRegion.style.width = (100 * Math.max(0, Math.min(1, (l.b - l.a) / duration))) + '%';
                paintLoopProgress(l);
            } else {
                loopRegion.style.display = 'none';
            }
            if (l) {
                loopBadgeText.textContent = fmtTime(l.a) + ' - ' + (l.half && !duration ? 'end' : fmtTime(l.b));
                loopBtn.classList.add('is-active');
                loopBtn.title = l.half
                    ? `Loop starts at ${fmtTime(l.a)}. Click to set the end here.`
                    : `Looping ${fmtTime(l.a)} - ${fmtTime(l.b)}. Click to clear.`;
            } else {
                loopBadgeText.textContent = '';
                loopBtn.classList.remove('is-active');
                loopBtn.title = 'Loop: set the start here';
            }
        };
        cell._mvSyncLoop = syncLoop;

        // Two no-op buffer seeks in a row means this stream won't seek
        // backwards at all, so stop trying and pay for a ?start= reload.
        let loopSeekAttempts = 0;
        const enforceLoop = () => {
            const l = isFilterBacked ? null : getLoop(id);
            if (!l) return;
            if (effectivePlayhead(video, id) < l.b - LOOP_EPSILON) {
                loopSeekAttempts = 0;
                return;
            }
            const how = jumpToLoopStart(id, video, l.a, loopSeekAttempts < 2);
            if (how === 'seek') loopSeekAttempts++;
            else if (how === 'reload') loopSeekAttempts = 0;
        };

        const startLoopDrag = (which, ev) => {
            if (ev.button !== 0) return;
            const l = getLoop(id);
            const duration = sceneDuration(id, video);
            if (!l || !duration) return;
            // Keep the seekbar's own click-to-seek out of this.
            ev.stopPropagation();
            ev.preventDefault();
            setActiveLoopDrag({ id, video, cell, which, seekbar, dur: duration, a: l.a, b: l.b, half: !!l.half });
        };
        handleA.addEventListener('mousedown', e => startLoopDrag('a', e));
        handleB.addEventListener('mousedown', e => startLoopDrag('b', e));

        // B at the end of the scene (or of a partial ?start= stream) ends
        // instead of crossing B, so restart from A here too.
        video.addEventListener('ended', () => {
            const l = isFilterBacked ? null : getLoop(id);
            if (l) jumpToLoopStart(id, video, l.a);
        });

        const updateProgress = () => {
            if (activeSeek && activeSeek.id === id) return;
            const duration = totalDuration(id, video);
            if (duration) seekFill.style.transform = 'scaleX(' + (effectivePlayhead(video, id) / duration) + ')';
            if (!activeLoopDrag || activeLoopDrag.id !== id) paintLoopProgress(isFilterBacked ? null : getLoop(id));
        };

        video.addEventListener('timeupdate', () => {
            if (video.seeking) return;
            enforceLoop();
            updateProgress();
        });

        // Duration is what turns marks into positions on the bar, so repaint
        // once the stream reports it (Stash usually knows it up front).
        video.addEventListener('loadedmetadata', () => syncLoop());
        syncLoop();

        // Debounced spinner: the browser fires rapid seeking/seeked
        // cycles during a buffer underrun. Showing/hiding the spinner on
        // each one produced the rapid-flashing crash look. Only show it if
        // the seek state persists past a short delay.
        let seekingSpinnerTimer = null;
        video.addEventListener('seeking', () => {
            clearTimeout(seekingSpinnerTimer);
            seekingSpinnerTimer = setTimeout(() => showSpinner(cell), SEEKING_SPINNER_DELAY_MS);
        });

        video.addEventListener('seeked', () => {
            clearTimeout(seekingSpinnerTimer);
            hideSpinner(cell);
            updateProgress();
        });

        video.addEventListener('canplay', () => {
            hideSpinner(cell);
        });

        seekbar.addEventListener('mousedown', e => {
            e.stopPropagation();
            const rect = seekbar.getBoundingClientRect();
            const fine = isFineSeek(e);
            const duration = totalDuration(id, video);
            // A plain grab is absolute: the bar means what it has always
            // meant, and the click jumps there. A fine grab anchors at the
            // current playhead instead, so you can inch a loop point in
            // without first losing your place.
            const originRatio = fine && duration
                ? Math.max(0, Math.min(1, effectivePlayhead(video, id) / duration))
                : (rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0);
            setActiveSeek({
                seekbar, fill: seekFill, video, id,
                ratio: originRatio, originRatio, originX: e.clientX, fine, moved: false,
            });
            seekFill.style.transform = 'scaleX(' + originRatio + ')';
            paintSeekTime(cell, rect, originRatio);
            if (!fine) commitSeek(); // immediate jump on click
        });

        cell.addEventListener('wheel', e => {
            if (!playerSettings.wheelSeek) return;
            // Don't hijack scrolling inside the volume popup (its slider
            // is wheel-adjustable in the browser by default).
            if (e.target.closest('.mv-vol-popup')) return;
            e.preventDefault();
            // Default: scroll up = forward. Invert flips it to scroll down =
            // forward (some users expect the page-scroll-down direction).
            const scrollUp = e.deltaY < 0;
            const forward = playerSettings.invertWheelSeek ? !scrollUp : scrollUp;
            const delta = (forward ? 1 : -1) * seekStepFor(e);
            if (isAllCellsSeek(e)) seekAllCells(delta);
            else scheduleWheelSeek(id, video, delta);
        }, { passive: false });

        cell.append(video, loadingDiv, overlay, popup, seekbar);

        cell.addEventListener('mouseleave', () => {
            if (openPopupId === id) closeAllPopups();
        });

        if (unmutedIds.has(id)) cell.classList.add('audio-active');

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
        // wired by now; if it's torn down during its delay (queue changed),
        // _mvCleanup sets cellTornDown and we skip starting a dead stream.
        const startDelay = staggerSlot * STREAM_STAGGER_MS;
        if (startDelay > 0) {
            setTimeout(() => { if (!cellTornDown) applyInitialSrc(); }, startDelay);
        } else {
            applyInitialSrc();
        }
    });

    // Remove cells no longer in queue. Walk the real DOM (not the id-keyed
    // `existing` map) so any stray duplicate-id cell is also torn down and
    // can't leak its <video>/watchdog. Keep only the canonical cell per id.
    for (const cell of Array.from(grid.children)) {
        const cid = cell.dataset.sceneId;
        if (cid && queueSet.has(cid) && existing.get(cid) === cell) continue;
        const v = cell.querySelector('video');
        if (v) {
            teardownPlayTracking(v);
            v._mvCleanup?.();
        }
        // Gains are keyed by scene id and connectAudio skips ids it already
        // has, so a stale entry would leave this scene's volume control
        // driving a dead node if it ever returns to the grid.
        if (cid && !queueSet.has(cid)) disconnectAudio(cid);
        cell.remove();
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
