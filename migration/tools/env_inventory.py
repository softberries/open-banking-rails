#!/usr/bin/env python3
"""Grep every ENV read in the repo. Usage: python3 -I env_inventory.py <src> <out_txt> <out_json>"""
import json, os, re, sys

src, out_txt, out_json = sys.argv[1:4]
pats = [
    re.compile(r'ENV\.fetch\(\s*["\']([A-Z0-9_]+)["\']\s*(?:,\s*([^)]*?))?\)\s*(\{[^}]*\})?'),
    re.compile(r'ENV\[\s*["\']([A-Z0-9_]+)["\']\s*\](?:\s*(?:\|\||\.presence\s*\|\|)\s*([^\n#]+))?'),
    re.compile(r'ENV\.key\?\(\s*["\']([A-Z0-9_]+)["\']'),
    re.compile(r'process\.env\.([A-Z0-9_]+)'),
    re.compile(r'\$\{([A-Z][A-Z0-9_]+)(?::?-([^}]*))?\}'),   # shell / compose
    re.compile(r'^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(\S*)', re.M),  # .env.example / shell assignment
]
skip_dirs = {'.git', 'node_modules', 'tmp', 'log', 'vendor', 'storage', 'coverage', 'public'}
exts = ('.rb', '.erb', '.yml', '.yaml', '.rake', '.js', '.sh', '.example', '.ru', 'Dockerfile', 'Procfile.dev')
found = {}
for root, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    for f in files:
        p = os.path.join(root, f)
        rel = os.path.relpath(p, src)
        if not (f.endswith(exts) or rel.startswith('bin/') or f.startswith('docker-entrypoint') or f == 'Dockerfile' or f.startswith('.env')):
            continue
        try:
            text = open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for k, pat in enumerate(pats):
                if k == 5 and not (f.startswith('.env') or rel.startswith('bin/') or f.endswith('.sh') or 'entrypoint' in f):
                    continue
                if k == 4 and not (f.endswith(('.yml', '.yaml', '.sh')) or rel.startswith('bin/') or 'entrypoint' in f or f == 'Dockerfile'):
                    continue
                for m in pat.finditer(line):
                    name = m.group(1)
                    if name in ('PATH', 'HOME', 'PWD', 'BASH_SOURCE') and k >= 4:
                        continue
                    default = None
                    if m.lastindex and m.lastindex >= 2:
                        default = next((g for g in m.groups()[1:] if g), None)
                    found.setdefault(name, []).append({'file': rel, 'line': i, 'default': (default or '').strip()[:80], 'code': line.strip()[:160]})
names = sorted(found)
json.dump({n: found[n] for n in names}, open(out_json, 'w'), indent=1)
with open(out_txt, 'w') as o:
    o.write('# ENV inventory (grep of ENV[...], ENV.fetch, ${VAR} in compose/shell, .env.example)\n')
    o.write('# NAME | defaults seen | usages (file:line)\n')
    for n in names:
        defs = sorted({u['default'] for u in found[n] if u['default']})
        o.write(f"{n} | {'; '.join(defs) or '-'} | {', '.join(u['file'] + ':' + str(u['line']) for u in found[n])}\n")
print(len(names), 'env vars')
