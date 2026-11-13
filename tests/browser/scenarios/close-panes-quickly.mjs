// Close two panes in quick succession while Stash is slow to answer
// (run with GQL_DELAY_MS=300 QUEUE='["1","2","3","5"]'). Both closes must
// stick: no pane comes back on a later poll, and the saved queue loses both.
const cells = `[...document.querySelectorAll('.mv-cell')]`;
const ids = `${cells}.map(c => c.dataset.sceneId).sort()`;
export const steps = [
    ['loaded', `return ${ids};`, 5000],
    ['closeTwo', `
        ${cells}.find(c => c.dataset.sceneId === '1').querySelector('.mv-cell-remove').click();
        await new Promise(r => setTimeout(r, 100));
        ${cells}.find(c => c.dataset.sceneId === '2').querySelector('.mv-cell-remove').click();
        return ${ids};`],
    // Long enough for the writes to land and two 5 s polls to run.
    ['afterPolls', `await new Promise(r => setTimeout(r, 12000)); return ${ids};`],
];
