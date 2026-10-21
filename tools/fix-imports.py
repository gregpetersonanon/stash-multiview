#!/usr/bin/env python3
"""Regenerate the import lines of every module in player/.

Each module's imports are worked out from the names it uses that another
module exports at top level. Names that only appear in comments, strings, or
the literal text of template strings don't count. Fails if two modules export
the same name or a module assigns a binding it imports (ES modules can't do
that; give the owner a setter instead). Also rewrites index.html's
PLAYER_MODULES list, which cache-busts each module.

Usage: tools/fix-imports.py [player_dir]   (default: player/ next to tools/)
"""
import os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
pdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'player')

EXPORT = re.compile(r'^export\s+(?:async\s+function|function|const|let)\s+([A-Za-z_$][\w$]*)', re.M)
IMPORT_LINE = re.compile(r'^import \{[^}]*\} from \'\./[\w-]+\.js\';\n', re.M)
IDENT = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)')


def code_only(text):
    text = '\n'.join(re.sub(r'(^|\s)//.*$', r'\1', l) for l in text.split('\n'))
    text = re.sub(r"'(?:\\.|[^'\\\n])*'", "''", text)
    text = re.sub(r'"(?:\\.|[^"\\\n])*"', '""', text)
    return re.sub(r'`(?:\\.|\$\{[^}]*\}|[^`\\])*`',
                  lambda m: ' '.join(re.findall(r'\$\{([^}]*)\}', m.group(0))), text)


modules = {f[:-3]: open(os.path.join(pdir, f), encoding='utf-8').read()
           for f in sorted(os.listdir(pdir)) if f.endswith('.js')}
bodies = {m: IMPORT_LINE.sub('', t).lstrip('\n') for m, t in modules.items()}

owner = {}
for m, body in bodies.items():
    for name in EXPORT.findall(body):
        if name in owner:
            sys.exit(f'{name} exported by both {owner[name]} and {m}')
        owner[name] = m

problems = []
for m, body in bodies.items():
    code = code_only(body)
    own = set(EXPORT.findall(body)) | set(re.findall(r'^(?:async\s+function|function|const|let)\s+([A-Za-z_$][\w$]*)', body, re.M))
    used = (set(IDENT.findall(code)) & set(owner)) - own
    imports = {}
    for name in sorted(used):
        imports.setdefault(owner[name], []).append(name)
        if re.search(r'(?<![\w$.])' + re.escape(name) + r'\s*(=(?![=>])|\+\+|--|[+\-*/]=)', code):
            problems.append(f'{m}.js assigns imported {name} (owned by {owner[name]}.js)')
    head = ''.join(f"import {{ {', '.join(ns)} }} from './{src}.js';\n" for src, ns in sorted(imports.items()))
    new = head + ('\n' if head else '') + body
    if new != modules[m]:
        with open(os.path.join(pdir, m + '.js'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(new)
        print(f'updated {m}.js')

# A module missing from index.html's import map still loads, just without its
# cache-buster, so a stale copy could survive an update. Rewrite the list.
html_path = os.path.join(pdir, '..', 'index.html')
html = open(html_path, encoding='utf-8').read()
rows, row = [], ''
for m in sorted(modules):
    item = f"'{m}', "
    if row and len(row) + len(item) > 64:
        rows.append(row.rstrip())
        row = ''
    row += item
rows.append(row.rstrip().rstrip(','))
listing = 'PLAYER_MODULES = [\n' + ''.join(f'            {r}\n' for r in rows) + '        ];'
new_html = re.sub(r'PLAYER_MODULES = \[.*?\];', lambda _: listing, html, flags=re.S)
if 'PLAYER_MODULES = [' not in html:
    problems.append('index.html has no PLAYER_MODULES list')
elif new_html != html:
    with open(html_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new_html)
    print('updated index.html module list')

if problems:
    sys.exit('\n'.join(problems))
