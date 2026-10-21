// Compare two drive.mjs results step by step (e.g. before and after a
// refactor). Usage: node tests/browser/compare.mjs <before.json> <after.json>
// Exits non-zero if any step differs or either run had problems.
import fs from 'node:fs';

const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const steps = Object.keys(a).filter(k => !k.startsWith('__'));
const differ = steps.filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
for (const k of differ) {
    console.log(`!! ${k}\n   before: ${JSON.stringify(a[k])}\n   after:  ${JSON.stringify(b[k])}`);
}
console.log(`${steps.length - differ.length}/${steps.length} steps identical`);
for (const [label, run] of [['before', a], ['after', b]]) {
    if (run.__problems.length) console.log(`${label} problems:\n  ${run.__problems.join('\n  ')}`);
}
process.exit(differ.length || a.__problems.length || b.__problems.length ? 1 : 0);
