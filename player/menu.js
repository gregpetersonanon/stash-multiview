import { ROULETTE_COUNT_KEY, ROULETTE_MODE_KEY } from './constants.js';
import { mutateQueue } from './queue-store.js';
import { render } from './render.js';
import { loadSceneMeta } from './scenes-api.js';
import { filterBackedCells, indexSavedQueue, queue, savedQueueIndex, setQueue } from './state.js';

// ── Roulette ───────────────────────────────────────────────────────────

// mode 'replace' (default): the roll overwrites the whole grid with `count`
// random scenes. mode 'add': append up to `count` random scenes to the
// current grid (filter cards and all), capped at 16 and skipping scenes
// already on screen — lets you mix a random roll alongside curated slots.
export async function loadRoulette(count, mode = 'replace') {
    try {
        const adding = mode === 'add';
        const want = adding ? Math.min(count, 16 - queue.length) : count;
        if (want <= 0) return;
        // In add mode fetch a buffer so we can drop scenes already on the grid.
        const perPage = adding ? want + queue.length : want;
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `query { findScenes(filter: { per_page: ${perPage}, sort: "random" }) { scenes { id } } }`
            })
        });
        const data = await res.json();
        let ids = (data?.data?.findScenes?.scenes || []).map(s => String(s.id));
        const rouletteFilter = { type: 'filter', filter: {} };

        if (adding) {
            const have = new Set(queue);
            ids = ids.filter(id => !have.has(id)).slice(0, want);
            if (!ids.length) return;
            ids.forEach(id => filterBackedCells.set(id, rouletteFilter));
            setQueue([...queue, ...ids]);
            // Append matching empty-filter slots to config (RMW) so a
            // reload reproduces them and other clients see the change.
            await mutateQueue(items => {
                const room = 16 - items.length;
                for (let i = 0; i < Math.min(ids.length, room); i++) {
                    savedQueueIndex.set(ids[i], items.length);
                    items.push({ type: 'filter', filter: {} });
                }
                return items;
            });
        } else {
            ids = ids.slice(0, want);
            if (!ids.length) return;
            // Replace is a deliberate full reset of the queue to fresh
            // random filter slots.
            await mutateQueue(() => ids.map(() => ({ type: 'filter', filter: {} })));
            filterBackedCells.clear();
            ids.forEach(id => filterBackedCells.set(id, rouletteFilter));
            indexSavedQueue(ids);
            setQueue(ids);
        }
        await loadSceneMeta(ids);
        render();
    } catch {}
}

// ── Menu panel ─────────────────────────────────────────────────────────

export function openMenuPanel() {
    if (document.getElementById('mv-menu-panel')) { closeMenuPanel(); return; }

    const savedCount = parseInt(localStorage.getItem(ROULETTE_COUNT_KEY) || '4');

    const panel = document.createElement('div');
    panel.id = 'mv-menu-panel';

    const rouletteSection = document.createElement('div');
    rouletteSection.className = 'mv-menu-section';

    const heading = document.createElement('span');
    heading.className = 'mv-menu-heading';
    heading.textContent = 'Roulette';

    const sliderRow = document.createElement('div');
    sliderRow.className = 'mv-menu-slider-row';

    const countDisplay = document.createElement('span');
    countDisplay.className = 'mv-menu-count';
    countDisplay.textContent = savedCount;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'mv-menu-slider';
    slider.min = 1;
    slider.max = 16;
    slider.value = savedCount;
    slider.addEventListener('input', () => { countDisplay.textContent = slider.value; });

    sliderRow.append(countDisplay, slider);

    // Replace / Add mode toggle.
    let rollMode = localStorage.getItem(ROULETTE_MODE_KEY) === 'add' ? 'add' : 'replace';
    const modeRow = document.createElement('div');
    modeRow.className = 'mv-menu-mode';
    const hint = document.createElement('div');
    hint.className = 'mv-menu-hint';
    const modeBtns = {};

    const rollBtn = document.createElement('button');
    rollBtn.className = 'mv-menu-roll-btn';
    rollBtn.textContent = 'Roll';
    rollBtn.addEventListener('click', () => {
        const count = parseInt(slider.value);
        localStorage.setItem(ROULETTE_COUNT_KEY, count);
        closeMenuPanel();
        loadRoulette(count, rollMode);
    });

    const applyMode = m => {
        rollMode = m;
        localStorage.setItem(ROULETTE_MODE_KEY, m);
        modeBtns.replace.classList.toggle('active', m === 'replace');
        modeBtns.add.classList.toggle('active', m === 'add');
        if (m === 'add') {
            // Cap the slider at the number of free slots — you can only add
            // as many as there's room for (16 total).
            const spare = Math.max(0, 16 - queue.length);
            slider.max = Math.max(1, spare);
            slider.disabled = rollBtn.disabled = spare <= 0;
            if (parseInt(slider.value) > spare) slider.value = String(Math.max(1, spare));
            hint.textContent = spare <= 0
                ? 'Grid is full (16). Remove a scene to add more.'
                : `Adds random scenes — ${spare} slot${spare === 1 ? '' : 's'} free.`;
        } else {
            slider.max = 16;
            slider.disabled = rollBtn.disabled = false;
            hint.textContent = 'Replaces every slot, including filter cards.';
        }
        countDisplay.textContent = slider.value;
    };
    [['replace', 'Replace'], ['add', 'Add']].forEach(([m, label]) => {
        const b = document.createElement('button');
        b.className = 'mv-menu-mode-btn';
        b.textContent = label;
        b.addEventListener('click', () => applyMode(m));
        modeBtns[m] = b;
        modeRow.appendChild(b);
    });
    applyMode(rollMode);

    rouletteSection.append(heading, sliderRow, modeRow, hint, rollBtn);
    panel.appendChild(rouletteSection);
    document.body.appendChild(panel);

    setTimeout(() => {
        document.addEventListener('mousedown', onMenuOutsideClick);
    }, 0);
}

export function closeMenuPanel() {
    document.getElementById('mv-menu-panel')?.remove();
    document.removeEventListener('mousedown', onMenuOutsideClick);
}

export function onMenuOutsideClick(e) {
    if (!e.target.closest('#mv-menu-panel') && !e.target.closest('#mv-roulette-btn')) {
        closeMenuPanel();
    }
}
