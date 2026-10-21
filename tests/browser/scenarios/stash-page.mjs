// The Stash-side script (multiView.js) on a stand-in scene list: card
// buttons, picking mode, the filter button and the launcher, all of which
// read and write the queue through the shared store. Starts with the fake's
// default queue: scenes 1, 2, 3 and one filter slot.
export const url = '/scenes?q=redhead';

const config = `(await (await fetch('/__log')).json()).config.multiView`;
const queue = `JSON.parse(${config}.queue)`;
const card = id => `document.querySelector('.mv-add-btn[data-scene-id="${id}"]')`;

export const steps = [
    ['cardButtons', `return [...document.querySelectorAll('.mv-add-btn')].map(b => [b.dataset.sceneId, b.classList.contains('mv-queued')]);`, 1500],
    ['addScene', `${card(4)}.click(); await new Promise(r => setTimeout(r, 800)); return { queue: ${queue}, queued: ${card(4)}.classList.contains('mv-queued') };`],
    ['removeScene', `${card(1)}.click(); await new Promise(r => setTimeout(r, 800)); return { queue: ${queue}, queued: ${card(1)}.classList.contains('mv-queued') };`],
    ['pickingOn', `document.querySelector('.mv-picking-toggle-btn').click(); await new Promise(r => setTimeout(r, 300)); return { picking: document.body.classList.contains('mv-picking-mode'), launcher: !!document.getElementById('mv-launcher'), scenes: document.getElementById('mv-scene-count').textContent, filters: document.getElementById('mv-filter-count').textContent };`],
    ['addFilter', `document.getElementById('mv-filter-add-btn').click(); await new Promise(r => setTimeout(r, 800)); return { last: ${queue}.at(-1), badge: document.querySelector('#mv-filter-add-btn .mv-filter-badge')?.textContent, filters: document.getElementById('mv-filter-count').textContent };`],
    ['otherKeysKept', `await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'mutation($input: Map!) { configurePlugin(plugin_id: "multiView", input: $input) }', variables: { input: Object.assign(${config}, { watched: '["kept"]' }) } }) }); ${card(1)}.click(); await new Promise(r => setTimeout(r, 800)); const c = ${config}; return { watched: c.watched, has1: JSON.parse(c.queue).includes('1') };`],
    ['clearQueue', `document.getElementById('mv-clear-queue').click(); await new Promise(r => setTimeout(r, 800)); return { queue: ${queue}, queuedCards: document.querySelectorAll('.mv-add-btn.mv-queued').length };`],
    ['syncFromElsewhere', `await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'mutation($input: Map!) { configurePlugin(plugin_id: "multiView", input: $input) }', variables: { input: Object.assign(${config}, { queue: '["2"]' }) } }) }); await new Promise(r => setTimeout(r, 6000)); return document.querySelectorAll('.mv-add-btn.mv-queued').length;`],
];
