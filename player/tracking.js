// ── Play tracking ───────────────────────────────────────────────────────
// Records plays to Stash so multiview-watched scenes appear in history and
// contribute to play_count / play_duration like the native player does.

export const playTrackers = new Map(); // video element → tracker
export let activityFlushTimer = null;
export const ACTIVITY_FLUSH_MS = 10000;

export function sceneAddPlay(id) {
    fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: `mutation AddPlay($id: ID!, $times: [Timestamp!]) { sceneAddPlay(id: $id, times: $times) { count } }`,
            variables: { id: String(id), times: [new Date().toISOString()] }
        })
    }).catch(() => {});
}

export function sceneSaveActivity(id, playDuration) {
    fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // resume_time omitted: looping/auto-advancing multiview cells have
        // no meaningful resume position.
        body: JSON.stringify({
            query: `mutation SaveActivity($id: ID!, $playDuration: Float) { sceneSaveActivity(id: $id, playDuration: $playDuration) }`,
            variables: { id: String(id), playDuration }
        })
    }).catch(() => {});
}

export function accumulatePlay(tracker) {
    if (tracker.sessionStart != null) {
        const now = performance.now();
        tracker.accumulated += (now - tracker.sessionStart) / 1000;
        tracker.sessionStart = now;
    }
}

// Bank the session and stop the clock. accumulatePlay alone keeps the
// session open, so the periodic flush would go on counting paused time.
export function endPlaySession(tracker) {
    accumulatePlay(tracker);
    tracker.sessionStart = null;
}

export function flushTracker(tracker) {
    accumulatePlay(tracker);
    if (tracker.accumulated >= 1) {
        sceneSaveActivity(tracker.sceneId, tracker.accumulated);
        tracker.accumulated = 0;
    }
}

export function flushAllTrackers() {
    for (const tracker of playTrackers.values()) flushTracker(tracker);
}

export function setupPlayTracking(id, video) {
    const tracker = { sceneId: id, accumulated: 0, sessionStart: null, addPlaySent: false };
    playTrackers.set(video, tracker);

    video.addEventListener('play', () => {
        if (tracker.sessionStart == null) tracker.sessionStart = performance.now();
        if (!tracker.addPlaySent) {
            tracker.addPlaySent = true;
            sceneAddPlay(id);
        }
    });
    video.addEventListener('pause', () => endPlaySession(tracker));
    video.addEventListener('ended', () => endPlaySession(tracker));

    if (!activityFlushTimer) {
        activityFlushTimer = setInterval(flushAllTrackers, ACTIVITY_FLUSH_MS);
    }
}

export function teardownPlayTracking(video) {
    const tracker = playTrackers.get(video);
    if (!tracker) return;
    flushTracker(tracker);
    playTrackers.delete(video);
    if (playTrackers.size === 0 && activityFlushTimer) {
        clearInterval(activityFlushTimer);
        activityFlushTimer = null;
    }
}
