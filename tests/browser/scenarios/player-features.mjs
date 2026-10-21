// Feature walk-through for comparing two builds of the player. Each step is
// [name, page-side async function body, ms to wait before it]. Results are
// kept free of random scene ids so two runs can be diffed.
const cells = `[...document.querySelectorAll('.mv-cell')]`;
const fire = (sel, type, extra = '{}') =>
    `document.querySelector('${sel}').dispatchEvent(new MouseEvent('${type}', Object.assign({ bubbles: true, cancelable: true, clientX: 0, clientY: 0 }, ${extra})))`;

export const steps = [
    ['loaded', `return { cells: ${cells}.length, title: document.getElementById('mv-title').textContent, grid: document.getElementById('mv-grid').className };`, 4000],
    ['playing', `return ${cells}.map(c => !c.querySelector('video').paused);`],
    ['pauseAll', `document.getElementById('mv-playpause-all-btn').click(); await new Promise(r => setTimeout(r, 300)); return { paused: ${cells}.every(c => c.querySelector('video').paused), title: document.getElementById('mv-playpause-all-btn').title };`],
    ['playAll', `document.getElementById('mv-playpause-all-btn').click(); await new Promise(r => setTimeout(r, 500)); return { playing: ${cells}.every(c => !c.querySelector('video').paused), title: document.getElementById('mv-playpause-all-btn').title };`],
    ['cellPause', `${cells}[0].querySelector('.mv-cell-playpause').click(); await new Promise(r => setTimeout(r, 300)); return { paused: ${cells}[0].querySelector('video').paused, btn: ${cells}[0].querySelector('.mv-cell-playpause').title };`],
    ['cellPlay', `${cells}[0].querySelector('.mv-cell-playpause').click(); await new Promise(r => setTimeout(r, 300)); return ${cells}[0].querySelector('video').paused;`],
    ['muteAll', `document.getElementById('mv-mute-all-btn').click(); return { unmuted: ${cells}.filter(c => !c.querySelector('video').muted).length, title: document.getElementById('mv-mute-all-btn').title };`],
    ['muteAllAgain', `document.getElementById('mv-mute-all-btn').click(); return ${cells}.filter(c => !c.querySelector('video').muted).length;`],
    ['volumePopup', `${cells}[1].querySelector('.mv-cell-audio-btn').click(); const p = ${cells}[1].querySelector('.mv-vol-popup'); const s = p.querySelector('input'); s.value = 0.5; s.dispatchEvent(new Event('input', { bubbles: true })); return { open: p.classList.contains('is-open'), label: p.querySelector('.mv-vol-label').textContent };`],
    ['popupMute', `${cells}[1].querySelector('.mv-popup-mute-btn').click(); return { muted: ${cells}[1].querySelector('video').muted, active: ${cells}[1].classList.contains('audio-active') };`],
    ['closePopup', `${fire('#mv-grid', 'mousedown')}; return document.querySelectorAll('.mv-vol-popup.is-open').length;`],
    ['oButton', `${cells}[0].querySelector('.mv-o-btn').click(); await new Promise(r => setTimeout(r, 300)); return ${cells}[0].querySelector('.mv-o-btn span').textContent;`],
    ['seekbarClick', `const c = ${cells}[0]; const bar = c.querySelector('.mv-seekbar'); const r = bar.getBoundingClientRect(); bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 1 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 1 })); await new Promise(r => setTimeout(r, 800)); return Math.round(c.querySelector('video').currentTime / 5) * 5;`],
    ['restart', `const c = ${cells}[0]; c.querySelector('.mv-cell-prev').click(); await new Promise(r => setTimeout(r, 500)); return c.querySelector('video').currentTime < 3;`],
    ['middleClickMute', `const c = ${cells}[2]; c.querySelector('video').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 })); return c.classList.contains('audio-active');`],
    ['loopA', `const c = ${cells}[0]; c.querySelector('.mv-cell-loop-btn')?.click(); return { looping: c.classList.contains('mv-looping'), badge: !!c.querySelector('.mv-loop-badge-text')?.textContent };`],
    ['loopB', `const c = ${cells}[0]; await new Promise(r => setTimeout(r, 1500)); c.querySelector('.mv-cell-loop-btn')?.click(); return c.querySelector('.mv-cell-loop-btn')?.title.startsWith('Looping');`],
    ['settingsOpen', `document.getElementById('mv-settings-btn').click(); const m = document.getElementById('mv-settings-modal'); return { open: !!m, sections: m.querySelectorAll('details').length, rows: m.querySelectorAll('.mv-settings-dp-row').length, loops: m.textContent.includes('1 scene loop') };`],
    ['settingsAccordion', `const d = [...document.querySelectorAll('#mv-settings-modal details')]; d[0].open = true; await new Promise(r => setTimeout(r, 50)); d[2].open = true; await new Promise(r => setTimeout(r, 50)); return d.map(x => x.open);`],
    ['wheelSeekToggle', `const t = document.querySelectorAll('#mv-settings-modal .mv-toggle')[1]; t.click(); return JSON.parse(localStorage.getItem('stash-multiview-settings')).wheelSeek;`],
    ['clearLoops', `const b = [...document.querySelectorAll('#mv-settings-modal button')].find(b => b.textContent === 'Clear All'); b.click(); return { disabled: b.disabled, looping: document.querySelectorAll('.mv-cell.mv-looping').length };`],
    ['settingsClose', `document.querySelector('.mv-settings-close').click(); return !!document.getElementById('mv-settings-modal');`],
    ['wheelSeek', `const c = ${cells}[1]; c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })); await new Promise(r => setTimeout(r, 800)); return c.querySelector('video').currentTime > 4;`],
    ['focusOn', `document.getElementById('mv-focus-btn').click(); await new Promise(r => setTimeout(r, 300)); return { focus: document.body.classList.contains('mv-focus'), positioned: ${cells}.every(c => c.style.width !== '') };`],
    ['focusOff', `document.getElementById('mv-focus-btn').click(); await new Promise(r => setTimeout(r, 300)); return { focus: document.body.classList.contains('mv-focus'), positioned: ${cells}.some(c => c.style.width !== '') };`],
    ['keyFocus', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })); const on = document.body.classList.contains('mv-focus'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })); return [on, document.body.classList.contains('mv-focus')];`],
    ['filterNext', `const c = document.querySelector('.mv-cell--filter'); const before = c.dataset.sceneId; c.querySelector('.mv-cell-next').click(); await new Promise(r => setTimeout(r, 1000)); const f = document.querySelector('.mv-cell--filter'); return { advanced: !!f && f.dataset.sceneId !== before, cells: ${cells}.length };`],
    ['menuOpen', `document.getElementById('mv-roulette-btn').click(); const p = document.getElementById('mv-menu-panel'); return { open: !!p, hint: p.querySelector('.mv-menu-hint').textContent.length > 0 };`],
    ['rollAdd', `const p = document.getElementById('mv-menu-panel'); [...p.querySelectorAll('.mv-menu-mode-btn')].find(b => b.textContent === 'Add').click(); const s = p.querySelector('.mv-menu-slider'); s.value = 2; s.dispatchEvent(new Event('input')); p.querySelector('.mv-menu-roll-btn').click(); await new Promise(r => setTimeout(r, 1500)); return { cells: ${cells}.length, random: document.querySelectorAll('.mv-cell--filter').length, panel: !!document.getElementById('mv-menu-panel'), grid: document.getElementById('mv-grid').className };`],
    ['removeCell', `${cells}[0].querySelector('.mv-cell-remove').click(); await new Promise(r => setTimeout(r, 1000)); return { cells: ${cells}.length, title: document.getElementById('mv-title').textContent };`],
    ['fullscreenBtn', `document.getElementById('mv-fullscreen-btn').click(); await new Promise(r => setTimeout(r, 300)); return document.getElementById('mv-fullscreen-btn').title;`],
    ['idle', `await new Promise(r => setTimeout(r, 3000)); return document.body.classList.contains('mv-idle');`],
    ['savedQueueLength', `return JSON.parse(localStorage.getItem('stash-multiview-queue')).length;`],
];
