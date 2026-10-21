#!/usr/bin/env python3
"""Build the canonical coverage key list from the machine inventory.
Usage: python3 -I coverage_keys.py <DIR>   (writes DIR/inventory/coverage_keys.json)
Each key -> {anchor, doc}: the doc that must contain `<a id="anchor"></a>`."""
import json, os, re, sys

DIR = sys.argv[1]
INV = os.path.join(DIR, "inventory")
SRC = sys.argv[2] if len(sys.argv) > 2 else "/workspace/ruby-service-investigator/src"

def slug(s):
    s = s.lower().replace("(.:format)", "").replace("(.json)", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s

keys = {}
def add(cat, key, anchor, doc, **extra):
    keys.setdefault(cat, {})[key] = {"anchor": anchor, "doc": doc, **extra}

# --- Rails routes (development set = superset; dev-only flagged) ---
def parse_routes(path):
    out, cur = [], {}
    for line in open(path):
        if line.startswith("--[ Route"):
            if cur: out.append(cur)
            cur = {}
        m = re.match(r"^(\w+)\s*\|\s*(.*)$", line.rstrip("\n"))
        if m: cur[m.group(1).strip()] = m.group(2).strip()
    if cur: out.append(cur)
    return out
test_routes = {(r.get("Verb", ""), r.get("URI", "")) for r in parse_routes(os.path.join(INV, "routes.txt"))}
for r in parse_routes(os.path.join(INV, "routes_development.txt")):
    verb, uri, ca = r.get("Verb", ""), r.get("URI", ""), r.get("Controller#Action", "")
    if not uri: continue
    path = uri.replace("(.:format)", "")
    if ca == "Api" and path == "/":
        add("routes", "MOUNT / (Grape Api)", "route-mount-grape-api", "30-http-api.md", controller="Api"); continue
    if not verb:
        add("routes", f"MOUNT {path}", "route-mount-" + slug(path), "30-http-api.md", controller=ca); continue
    for v in verb.split("|"):
        dev_only = (verb, uri) not in test_routes
        add("routes", f"{v} {path}", f"route-{v.lower()}-{slug(path) or 'root'}", "30-http-api.md", controller=ca, dev_only=dev_only)

# --- Grape API ---
for r in json.load(open(os.path.join(INV, "api_routes.json"))):
    path = r["path"].replace("/api/:version", "/api/v1").replace("(.json)", "").replace("(.:format)", "")
    add("routes", f"{r['method']} {path}", f"route-{r['method'].lower()}-{slug(path)}", "30-http-api.md", controller="Grape")

# --- MCP tools ---
for t in json.load(open(os.path.join(INV, "mcp_tools.json"))):
    add("mcp_tools", t["name"], "mcp-" + slug(t["name"]), "30-http-api.md", file=t["file"])

# --- Models (AR registry + every file in app/models) ---
for m in json.load(open(os.path.join(INV, "models.json"))):
    add("models", m["name"], "model-" + slug(m["name"]), "10-domain-model.md", table=m["table"], app_model=m["app_model"])
for f in sorted(os.listdir(os.path.join(SRC, "app/models"))):
    if f.endswith(".rb") and f != "application_record.rb":
        name = "".join(p.capitalize() for p in f[:-3].split("_"))
        if name not in keys["models"]:
            add("models", name, "model-" + slug(name), "10-domain-model.md", note="non-AR class in app/models")

# --- Tables (schema.rb tables + views) ---
schema = open(os.path.join(INV, "schema.rb")).read()
for t in re.findall(r'create_table "([^"]+)"', schema):
    add("tables", t, "table-" + slug(t), "50-data.md")
for v in re.findall(r'create_view "([^"]+)"', schema):
    add("tables", v + " (view)", "table-" + slug(v), "50-data.md")

# --- Jobs + cron schedule ---
for j in json.load(open(os.path.join(INV, "jobs.json"))):
    add("jobs", j["class"], "job-" + slug(j["class"]), "60-async-and-integrations.md", file=j["file"])
for name in re.findall(r"^(\w+):\s*$", open(os.path.join(SRC, "config/schedule.yml")).read(), re.M):
    add("jobs", f"cron:{name}", "cron-" + slug(name), "60-async-and-integrations.md")

# --- Mailers ---
for m in json.load(open(os.path.join(INV, "mailers.json"))):
    add("mailers", m["class"], "mailer-" + slug(m["class"]), "60-async-and-integrations.md", actions=m["actions"])

# --- Pages / layouts / partials (templates) ---
for root, _, files in os.walk(os.path.join(SRC, "app/views")):
    for f in sorted(files):
        rel = os.path.relpath(os.path.join(root, f), os.path.join(SRC, "app/views"))
        name = re.sub(r"\.(html|json|turbo_stream|text)?\.?erb$|\.erb$", "", rel)
        if rel.startswith("layouts/"):
            add("layouts", rel, "layout-" + slug(name), "40-ui.md")
        elif f.startswith("_"):
            group = os.path.dirname(rel)
            add("partials", rel, "partial-" + slug(name), "40-ui.md", group=group)
        else:
            add("pages", rel, "page-" + slug(name), "40-ui.md")

# --- JS controllers ---
for f in sorted(os.listdir(os.path.join(SRC, "app/javascript/controllers"))):
    if f.endswith("_controller.js"):
        add("js_controllers", f, "js-" + slug(f[:-3]), "40-ui.md")

# --- ENV ---
for line in open(os.path.join(INV, "env.txt")):
    if line.startswith("#") or "|" not in line: continue
    name = line.split("|")[0].strip()
    name = name.replace(" (implicit)", "")
    if name == "OTEL_*": name = "OTEL_* (SDK-standard, implicit)"
    if name not in keys.get("env", {}):
        add("env", name, "env-" + slug(name), "70-security-and-config.md")

# --- Rake tasks ---
for t in json.load(open(os.path.join(INV, "rake_tasks.json"))):
    add("rake_tasks", t["name"], "rake-" + slug(t["name"]), "60-async-and-integrations.md", file=t["file"])

# --- Initializers ---
for f in sorted(os.listdir(os.path.join(SRC, "config/initializers"))):
    add("initializers", f, "init-" + slug(f[:-3]), "70-security-and-config.md")

# --- Service objects / forms / API entities+helpers / MCP infra / helpers ---
for base, cat, doc in [("app/services", "services", "20-business-rules.md"), ("app/forms", "services", "20-business-rules.md")]:
    for root, _, files in os.walk(os.path.join(SRC, base)):
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(root, f), SRC)
            add(cat, rel, "svc-" + slug(rel.replace("app/services/", "").replace(".rb", "")), doc)

out = os.path.join(INV, "coverage_keys.json")
json.dump(keys, open(out, "w"), indent=1)
print({k: len(v) for k, v in keys.items()})
