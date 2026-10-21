import { ICON_REMOVE } from './icons.js';
import { KEYBIND_ACTIONS, keyLabel, normalizeKey } from './keybinds.js';
import { applyLoopState, clearAllLoops, loopCount } from './loops.js';
import { applyQualityToAllCells } from './render.js';
import { SEEK_MODIFIERS, SEEK_STEP_MAX } from './seek.js';
import { GRID_ROWS, QUALITY_OPTIONS, clampStep, playerSettings, savePlayerSettings } from './settings.js';

export let keybindCaptureActive = false;
export function openSettingsModal() {
    if (document.getElementById('mv-settings-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mv-settings-modal';

    const card = document.createElement('div');
    card.className = 'mv-settings-card';

    // Header
    const header = document.createElement('div');
    header.className = 'mv-settings-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'mv-settings-title';
    titleEl.textContent = 'Player Settings';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'mv-settings-close';
    closeBtn.innerHTML = ICON_REMOVE;
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', closeSettingsModal);
    header.append(titleEl, closeBtn);

    // Direct play row
    const dpRow = document.createElement('div');
    dpRow.className = 'mv-settings-dp-row';
    const dpText = document.createElement('div');
    dpText.className = 'mv-settings-dp-text';
    const dpLabel = document.createElement('span');
    dpLabel.className = 'mv-settings-dp-label';
    dpLabel.textContent = 'Direct Play';
    const dpDesc = document.createElement('span');
    dpDesc.className = 'mv-settings-dp-desc';
    dpDesc.textContent = 'Stream the original file without transcoding. Recommended for NAS or low-powered servers.';
    dpText.append(dpLabel, dpDesc);
    const dpToggle = document.createElement('input');
    dpToggle.type = 'checkbox';
    dpToggle.className = 'mv-toggle';
    dpToggle.checked = playerSettings.directPlay;
    dpRow.append(dpText, dpToggle);

    // Scroll-wheel seek row
    const swRow = document.createElement('div');
    swRow.className = 'mv-settings-dp-row';
    const swText = document.createElement('div');
    swText.className = 'mv-settings-dp-text';
    const swLabel = document.createElement('span');
    swLabel.className = 'mv-settings-dp-label';
    swLabel.textContent = 'Scroll-Wheel Seek';
    const swDesc = document.createElement('span');
    swDesc.className = 'mv-settings-dp-desc';
    swDesc.textContent = 'Scroll the mouse wheel over a video to skip back or forward by the seek step (set under Seeking).';
    swText.append(swLabel, swDesc);
    const swToggle = document.createElement('input');
    swToggle.type = 'checkbox';
    swToggle.className = 'mv-toggle';
    swToggle.checked = playerSettings.wheelSeek;
    swToggle.addEventListener('change', () => {
        playerSettings.wheelSeek = swToggle.checked;
        savePlayerSettings();
        invToggle.disabled = !swToggle.checked;
        invRow.classList.toggle('mv-settings-disabled', !swToggle.checked);
    });
    swRow.append(swText, swToggle);

    // Invert scroll-seek direction row (only meaningful when seek is on)
    const invRow = document.createElement('div');
    invRow.className = 'mv-settings-dp-row';
    const invText = document.createElement('div');
    invText.className = 'mv-settings-dp-text';
    const invLabel = document.createElement('span');
    invLabel.className = 'mv-settings-dp-label';
    invLabel.textContent = 'Invert Scroll-Seek Direction';
    const invDesc = document.createElement('span');
    invDesc.className = 'mv-settings-dp-desc';
    invDesc.textContent = 'Off: scroll up = forward. On: scroll down = forward.';
    invText.append(invLabel, invDesc);
    const invToggle = document.createElement('input');
    invToggle.type = 'checkbox';
    invToggle.className = 'mv-toggle';
    invToggle.checked = playerSettings.invertWheelSeek;
    invToggle.disabled = !playerSettings.wheelSeek;
    invToggle.addEventListener('change', () => {
        playerSettings.invertWheelSeek = invToggle.checked;
        savePlayerSettings();
    });
    invRow.append(invText, invToggle);
    if (!playerSettings.wheelSeek) invRow.classList.add('mv-settings-disabled');

    // Default volume row
    const volRow = document.createElement('div');
    volRow.className = 'mv-settings-dp-row';
    const volText = document.createElement('div');
    volText.className = 'mv-settings-dp-text';
    const volLbl = document.createElement('span');
    volLbl.className = 'mv-settings-dp-label';
    volLbl.textContent = 'Default Volume';
    const volDesc = document.createElement('span');
    volDesc.className = 'mv-settings-dp-desc';
    volDesc.textContent = 'Starting volume for each video when unmuted.';
    volText.append(volLbl, volDesc);
    const volWrap = document.createElement('div');
    volWrap.className = 'mv-settings-vol-wrap';
    const volVal = document.createElement('span');
    volVal.className = 'mv-settings-vol-val';
    volVal.textContent = Math.round(playerSettings.defaultVolume * 100) + '%';
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.className = 'mv-settings-vol-slider';
    volSlider.min = 0;
    volSlider.max = 2;
    volSlider.step = 0.05;
    volSlider.value = playerSettings.defaultVolume;
    volSlider.title = 'Default volume (0–200%)';
    volSlider.addEventListener('input', () => {
        const v = parseFloat(volSlider.value);
        playerSettings.defaultVolume = v;
        volVal.textContent = Math.round(v * 100) + '%';
        savePlayerSettings();
    });
    volWrap.append(volVal, volSlider);
    volRow.append(volText, volWrap);

    // Saved A/B loops row. Loops are deliberate work with no expiry, so
    // there has to be one obvious place to wipe them all.
    const loopRow = document.createElement('div');
    loopRow.className = 'mv-settings-dp-row';
    const loopText = document.createElement('div');
    loopText.className = 'mv-settings-dp-text';
    const loopLbl = document.createElement('span');
    loopLbl.className = 'mv-settings-dp-label';
    loopLbl.textContent = 'Saved A/B Loops';
    const loopDesc = document.createElement('span');
    loopDesc.className = 'mv-settings-dp-desc';
    const describeLoops = () => {
        const n = loopCount();
        loopDesc.textContent = n
            ? `${n} scene${n > 1 ? 's' : ''} loop a set range. Mark them per cell with the loop button or the A/B shortcuts.`
            : 'No loops set. Mark a range on a cell with the loop button or the A/B shortcuts.';
    };
    describeLoops();
    loopText.append(loopLbl, loopDesc);
    const loopClearBtn = document.createElement('button');
    loopClearBtn.className = 'mv-keybind-btn';
    loopClearBtn.textContent = 'Clear All';
    loopClearBtn.disabled = loopCount() === 0;
    loopClearBtn.addEventListener('click', () => {
        clearAllLoops();
        document.querySelectorAll('.mv-cell').forEach(cell => {
            const video = cell.querySelector('video');
            if (video) applyLoopState(cell.dataset.sceneId, video);
        });
        describeLoops();
        loopClearBtn.disabled = true;
    });
    loopRow.append(loopText, loopClearBtn);

    // Collapsible section, chevron and all. Returns the <details> to append
    // and the body rows go into `.rows`.
    const makeSection = title => {
        const section = document.createElement('details');
        section.className = 'mv-settings-section';
        const summary = document.createElement('summary');
        summary.className = 'mv-settings-section-heading mv-section-summary';
        summary.textContent = title;
        const rows = document.createElement('div');
        rows.className = 'mv-section-rows';
        section.append(summary, rows);
        return { section, rows };
    };

    // Seeking section. The two modifier roles live here rather than in
    // Shortcuts because a binding holds one bare key and cannot carry a
    // modifier; the actions they modify are rebindable as usual.
    const { section: seekSection, rows: seekRows } = makeSection('Seeking');

    const addStepRow = (label, key, title) => {
        const row = document.createElement('div');
        row.className = 'mv-settings-qual-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = title;
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'mv-seek-step-input';
        input.min = 0.25;
        input.max = SEEK_STEP_MAX;
        input.step = 0.25;
        input.value = playerSettings[key];
        input.title = title;
        input.addEventListener('change', () => {
            playerSettings[key] = clampStep(input.value, playerSettings[key]);
            input.value = playerSettings[key];
            savePlayerSettings();
        });
        row.append(lbl, input);
        seekRows.appendChild(row);
    };
    addStepRow('Seek step (seconds)', 'seekStep',
        'How far the wheel and the seek shortcuts move the playhead.');
    addStepRow('Fine step (seconds)', 'seekStepFine',
        'Step used while the fine modifier is held.');

    // Both roles read the same modifier keys, so they must not collide.
    const modSelects = {};
    const addModRow = (label, key, title) => {
        const row = document.createElement('div');
        row.className = 'mv-settings-qual-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.title = title;
        const sel = document.createElement('select');
        sel.className = 'mv-quality-select';
        sel.title = title;
        SEEK_MODIFIERS.forEach(m => {
            const o = document.createElement('option');
            o.value = m.value;
            o.textContent = m.label + (m.value === 'ctrl' ? ' (fights browser zoom)' : '');
            if (m.value === playerSettings[key]) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            playerSettings[key] = sel.value;
            savePlayerSettings();
            syncModSelects();
        });
        modSelects[key] = sel;
        row.append(lbl, sel);
        seekRows.appendChild(row);
    };
    // Grey out the modifier the other role already owns, so the two can
    // never be set to the same key and race each other.
    function syncModSelects() {
        Object.entries(modSelects).forEach(([key, sel]) => {
            const otherKey = key === 'fineModifier' ? 'allCellsModifier' : 'fineModifier';
            const taken = playerSettings[otherKey];
            Array.from(sel.options).forEach(o => {
                o.disabled = o.value !== 'none' && o.value === taken;
            });
        });
    }
    addModRow('Fine seek modifier', 'fineModifier',
        'Hold to use the fine step, and to scale down seekbar drag travel.');
    addModRow('All cells modifier', 'allCellsModifier',
        'Hold to move every cell by the same amount instead of just the hovered one.');
    syncModSelects();

    // Quality section
    const { section: qualSection, rows: qualRows } = makeSection('Quality per Grid Size');

    const selects = {};
    GRID_ROWS.forEach(({ key, label }) => {
        const row = document.createElement('div');
        row.className = 'mv-settings-qual-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        const sel = document.createElement('select');
        sel.className = 'mv-quality-select';
        sel.disabled = playerSettings.directPlay;
        QUALITY_OPTIONS.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === playerSettings.quality[key]) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            playerSettings.quality[key] = sel.value;
            savePlayerSettings();
            applyQualityToAllCells();
        });
        selects[key] = sel;
        row.append(lbl, sel);
        qualRows.appendChild(row);
    });

    dpToggle.addEventListener('change', () => {
        playerSettings.directPlay = dpToggle.checked;
        savePlayerSettings();
        Object.values(selects).forEach(sel => { sel.disabled = dpToggle.checked; });
        applyQualityToAllCells();
    });

    // Shortcuts section — collapsed by default (native <details>) to keep
    // the panel tidy; bind a keyboard key or mouse button per action.
    const { section: kbSection, rows: kbRows } = makeSection('Shortcuts');

    function renderKeybindRows() {
        kbRows.innerHTML = '';
        KEYBIND_ACTIONS.forEach(action => {
            const row = document.createElement('div');
            row.className = 'mv-settings-qual-row';
            const lbl = document.createElement('label');
            lbl.textContent = action.label;
            const btn = document.createElement('button');
            btn.className = 'mv-keybind-btn';
            btn.textContent = keyLabel(playerSettings.keybinds[action.id]);
            btn.title = 'Click to rebind. Backspace clears, Esc cancels.';
            btn.addEventListener('click', () => beginRebind(action, btn));
            row.append(lbl, btn);
            kbRows.appendChild(row);
        });
    }

    function beginRebind(action, btn) {
        if (keybindCaptureActive) return;
        keybindCaptureActive = true;
        btn.classList.add('capturing');
        btn.textContent = 'Press a key or mouse button…';

        // Assign `binding` to this action (or '' to clear), stealing it from
        // any other action that held it, then tear down capture and re-render.
        const finish = binding => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('mousedown', onMouse, true);
            document.removeEventListener('contextmenu', swallow, true);
            keybindCaptureActive = false;
            btn.classList.remove('capturing');
            if (binding !== null) {
                if (binding) {
                    KEYBIND_ACTIONS.forEach(a => {
                        if (a.id !== action.id && playerSettings.keybinds[a.id] === binding) {
                            playerSettings.keybinds[a.id] = '';
                        }
                    });
                }
                playerSettings.keybinds[action.id] = binding;
                savePlayerSettings();
            }
            renderKeybindRows();
        };
        const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
        const onKey = ev => {
            swallow(ev);
            if (ev.key === 'Escape') return finish(null);              // cancel
            if (ev.key === 'Backspace' || ev.key === 'Delete') return finish('');
            finish(normalizeKey(ev.key));
        };
        const onMouse = ev => {
            swallow(ev);
            // Left click cancels (lets you click away); any other button binds.
            if (ev.button === 0) return finish(null);
            finish('Mouse' + ev.button);
        };
        // Capture phase so we beat the global shortcut handlers to the input.
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onMouse, true);
        document.addEventListener('contextmenu', swallow, true);
    }

    renderKeybindRows();

    // Accordion: opening one section closes the others, so the panel never
    // grows past a screen. Closing the others fires their own toggle, which
    // returns immediately because they are shut.
    const sections = [seekSection, qualSection, kbSection];
    sections.forEach(section => {
        section.addEventListener('toggle', () => {
            if (!section.open) return;
            sections.forEach(other => { if (other !== section) other.open = false; });
        });
    });

    card.append(header, dpRow, swRow, invRow, volRow, loopRow, seekSection, qualSection, kbSection);
    overlay.appendChild(card);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSettingsModal(); });
    document.body.appendChild(overlay);
}

export function closeSettingsModal() {
    document.getElementById('mv-settings-modal')?.remove();
}
