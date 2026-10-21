import { queue, scenes } from './state.js';
import { parseStreams } from './stream.js';

// ── GraphQL ────────────────────────────────────────────────────────────

export async function fetchSceneMeta(id) {
    try {
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `query FindScene($id: ID!) {
                    findScene(id: $id) {
                        title
                        o_counter
                        files { path duration }
                        sceneStreams { url mime_type label }
                    }
                }`,
                variables: { id: String(id) }
            })
        });
        const data = await res.json();
        const scene = data?.data?.findScene;
        if (!scene) return;
        let title = scene.title;
        if (!title) {
            const path = scene.files?.[0]?.path;
            title = path ? path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : String(id);
        }
        scenes[id] = { id, title, oCount: scene.o_counter ?? 0, duration: scene.files?.[0]?.duration ?? null, streams: parseStreams(scene.sceneStreams) };
    } catch {
        if (!scenes[id]) scenes[id] = { id, title: String(id), streams: {} };
    }
}

export async function loadSceneMeta(ids) {
    await Promise.all(ids.filter(id => typeof id === 'string' && !scenes[id]).map(fetchSceneMeta));
}

export async function incrementO(id) {
    try {
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `mutation IncrementO($id: ID!) { sceneIncrementO(id: $id) }`,
                variables: { id: String(id) }
            })
        });
        const data = await res.json();
        const newCount = data?.data?.sceneIncrementO;
        if (newCount != null && scenes[id]) {
            scenes[id].oCount = newCount;
            const btn = document.querySelector(`.mv-cell[data-scene-id="${id}"] .mv-o-btn span`);
            if (btn) btn.textContent = newCount;
        }
    } catch {}
}

export async function incrementAllO() {
    await Promise.all(queue.map(incrementO));
}
