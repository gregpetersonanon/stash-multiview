// The queue is emptied from elsewhere (another tab or device), then refilled.
const setQueue = q => `await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'mutation($input: Map!) { configurePlugin(plugin_id: "multiView", input: $input) }', variables: { input: { queue: JSON.stringify(${q}) } } }) });`;
export const steps = [
    ['loaded', `return document.querySelectorAll('.mv-cell').length;`, 4000],
    ['clearedElsewhere', `${setQueue('[]')} await new Promise(r => setTimeout(r, 6000)); return { cells: document.querySelectorAll('.mv-cell').length, empty: document.getElementById('mv-empty').style.display, title: document.getElementById('mv-title').textContent };`],
    ['refilled', `${setQueue("['1', '3']")} await new Promise(r => setTimeout(r, 7000)); return { cells: document.querySelectorAll('.mv-cell').length, playing: [...document.querySelectorAll('.mv-cell video')].every(v => !v.paused) };`],
];
