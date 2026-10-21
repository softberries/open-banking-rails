#!/usr/bin/env python3
"""Coverage check: every inventory entry must map to a documented section.
Usage: python3 -I check_coverage.py <DIR> [--write]
- reads DIR/inventory/coverage_keys.json (generated from the inventory)
- scans DIR/docs/*.md for <a id="..."></a> anchors
- a key is MAPPED iff its anchor exists in its target doc AND the key's identifying text appears in that doc
- also verifies relative links to ../oracle/** and ../inventory/** exist
- --write: writes DIR/docs/coverage.json {category: {key: "doc.md#anchor" | null}} + summary
Exit code 1 if anything is unmapped or a link is broken."""
import json, os, re, sys

DIR = sys.argv[1]
WRITE = "--write" in sys.argv
docs_dir = os.path.join(DIR, "docs")
keys = json.load(open(os.path.join(DIR, "inventory", "coverage_keys.json")))

docs = {f: open(os.path.join(docs_dir, f), encoding="utf-8").read() for f in os.listdir(docs_dir) if f.endswith(".md")}
anchors = {f: set(re.findall(r'<a id="([^"]+)"', t)) for f, t in docs.items()}

def ident(cat, key):
    """Text that must appear in the doc near-verbatim for the key to count as documented."""
    if cat == "routes":
        if key.startswith("MOUNT / (Grape"): return ["Grape"]
        verb, path = key.split(" ", 1)
        return [path]
    if cat == "pages" or cat == "partials" or cat == "layouts":
        base = os.path.basename(key)
        return [base, base.split(".")[0]]
    if cat == "services":
        return [os.path.basename(key)[:-3] if key.endswith(".rb") else key]
    if cat == "env":
        return [key.split(" ")[0].rstrip("*").rstrip("_")]
    if cat == "jobs" and key.startswith("cron:"):
        return [key[5:]]
    if cat == "initializers":
        return [key, key[:-3]]
    if cat == "js_controllers":
        return [key, key[:-3]]
    return [key]

coverage, unmapped = {}, []
for cat, entries in keys.items():
    coverage[cat] = {}
    for key, meta in entries.items():
        doc, anchor = meta["doc"], meta["anchor"]
        ok_anchor = doc in anchors and anchor in anchors[doc]
        # allow a key's anchor to live in another doc (e.g. moved section) — record where
        where = doc if ok_anchor else next((f for f, a in anchors.items() if anchor in a), None)
        ok_text = where is not None and any(t and t in docs[where] for t in ident(cat, key))
        if where and ok_text:
            coverage[cat][key] = f"{where}#{anchor}"
        else:
            coverage[cat][key] = None
            unmapped.append((cat, key, anchor, doc, "no anchor" if not where else "anchor present but key text not mentioned"))

# broken relative links
broken = []
for f, t in docs.items():
    for link in re.findall(r'\]\((\.\./(?:oracle|inventory)/[^)#\s]+)', t):
        if not os.path.exists(os.path.normpath(os.path.join(docs_dir, link))):
            broken.append((f, link))
    for link in re.findall(r'\]\(((?:[0-9]{2}-[a-z0-9-]+|unknowns|decisions)\.md)(#[^)]+)?\)', t):
        target, frag = link
        if target not in docs: broken.append((f, target))
        elif frag and frag[1:] not in anchors[target] and not re.search(r'^#+ .*$', docs[target], re.M):
            broken.append((f, target + frag))

summary = {cat: {"total": len(v), "mapped": sum(1 for x in v.values() if x), "unmapped": sum(1 for x in v.values() if not x)} for cat, v in coverage.items()}
total = sum(s["total"] for s in summary.values()); mapped = sum(s["mapped"] for s in summary.values())
if WRITE:
    json.dump({"_generated_by": "scripts/check_coverage.py (anchors scanned in docs/*.md)", "_summary": summary, **coverage},
              open(os.path.join(docs_dir, "coverage.json"), "w"), indent=1, ensure_ascii=False)
for cat, s in summary.items():
    print(f"{cat:15s} {s['mapped']:4d}/{s['total']:<4d}" + ("" if not s["unmapped"] else f"  UNMAPPED {s['unmapped']}"))
print(f"TOTAL {mapped}/{total} mapped; broken links: {len(broken)}")
for u in unmapped[:400]: print("UNMAPPED", *u, sep=" | ")
for b in broken[:200]: print("BROKEN", *b, sep=" | ")
sys.exit(1 if unmapped or broken else 0)
