export const STORAGE_KEY = 'stash-multiview-queue';
export const ROULETTE_COUNT_KEY = 'stash-multiview-roulette-count';
export const ROULETTE_MODE_KEY = 'stash-multiview-roulette-mode'; // 'replace' | 'add'
export const SETTINGS_KEY = 'stash-multiview-settings';

// Stall recovery tuning. A stalled transcode is re-sourced from the
// current playhead, but bounded so a permanently-dead stream can't
// hammer the shared transcoder into a freeze:
//  - STALL_TIMEOUT_MS: how long a `waiting` may persist before we act.
//  - RECOVERY_COOLDOWN_MS: minimum gap between two recoveries on one
//    cell, so rapid waiting/error bursts collapse into one attempt.
//  - MAX_RECOVERIES: hard cap; once hit we give up (filter cells advance).
//  - SUSTAINED_PLAY_MS: budget is forgiven ONE recovery at a time only
//    after this much *uninterrupted* playback (a stall cancels the window).
//    Kept above STALL_TIMEOUT_MS so a stream must play substantially longer
//    than it takes to detect a stall before earning budget back — a tight
//    stall loop therefore walks up to the cap instead of looping forever.
export const STALL_TIMEOUT_MS = 12000;
export const RECOVERY_COOLDOWN_MS = 6000;
export const MAX_RECOVERIES = 3;
export const SUSTAINED_PLAY_MS = 20000;
export const SEEKING_SPINNER_DELAY_MS = 350;
// When a render adds several cells at once (initial load, roulette roll),
// ramp their stream starts apart by this much per cell instead of firing
// all N transcode requests at the same instant — a simultaneous burst
// saturates a slow link / the shared transcoder and makes every cell stall.
export const STREAM_STAGGER_MS = 200;
// Hide the hover overlay/controls and the cursor after the pointer sits
// still this long, like a video player. Any movement restores them.
export const IDLE_HIDE_MS = 2500;

export const PROGRESS_KEY = 'stash-multiview-progress';
export const PROGRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PROGRESS_SAVE_INTERVAL_MS = 5000;
export const PROGRESS_MIN_SAVE = 5;
// If a saved position is within this many seconds of the end (or past it —
// e.g. the scene was re-encoded shorter since), don't resume: a ?start=
// past EOF triggers an immediate error/recovery storm, and resuming into
// the last few seconds is pointless. Start fresh instead.
export const PROGRESS_END_MARGIN = 10;

// How close to the bottom of a cell the pointer has to be for that cell to
// enter its "seek zone" (bar grows, controls lift, time readout appears).
// Measured in JS because the overlay covers the bar's hit strip; see the
// .mv-seek-zone rules in the stylesheet for why :hover cannot do this.
export const SEEK_ZONE_PX = 34;

// A/B loops. Per-scene [A, B] range that a cell replays forever instead of
// playing the whole scene. Stored per scene id in localStorage, no TTL (a
// loop is deliberate user work, unlike a resume position), pruned to the
// most recently touched LOOP_MAX_ENTRIES so the map can't grow forever.
//  - LOOP_MIN_SECONDS: shortest range we accept, so a stray double-tap
//    can't create a 100ms loop that just thrashes the decoder.
//  - LOOP_EPSILON: timeupdate only fires ~4x/sec, so treat "at B" as
//    slightly before B rather than waiting to overshoot it.
//  - LOOP_RESOURCE_COOLDOWN_MS: a transcoded cell that can't seek inside
//    its buffer has to re-request the stream at ?start=A to loop. That
//    spawns a fresh ffmpeg each time, so bound how often one cell may do
//    it; a loop shorter than the cooldown just overruns B a little.
export const LOOPS_KEY = 'stash-multiview-loops';
export const LOOP_MIN_SECONDS = 1;
export const LOOP_EPSILON = 0.15;
export const LOOP_RESOURCE_COOLDOWN_MS = 3000;
export const LOOP_MAX_ENTRIES = 500;
