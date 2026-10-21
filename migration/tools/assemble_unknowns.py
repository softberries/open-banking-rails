#!/usr/bin/env python3
"""Assemble docs/unknowns.md from docs/_fragments/unknowns-*.md, with theme index and decision resolutions.
Usage: python3 -I assemble_unknowns.py <DIR>"""
import re, sys, glob

D = sys.argv[1] + "/docs"
F = D + "/_fragments"
entries = {}
for f in glob.glob(F + "/unknowns-*.md"):
    t = open(f).read()
    for m in re.finditer(r'^### (U-(\d{3}))(.*?)(?=^### U-|\Z)', t, re.S | re.M):
        entries[int(m.group(2))] = m.group(0).rstrip() + "\n"

R = {}  # id -> resolution text
def res(ids, text):
    for i in ids: R.setdefault(i, []).append(text)

res([1], "Resolved by D-001 (Spring Boot 3 + JPA/Hibernate + Flyway + Spring Security + JobRunr).")
res([106, 818, 107, 105], "Resolved by D-005 (in-place compatibility: Flyway baseline from schema.rb, Rails AR-encryption format, PaperTrail YAML kept).")
res([101, 200, 506, 121, 500, 811, 501, 810, 100, 300, 700, 712, 320, 524, 604, 209, 512, 605, 806, 304, 505, 521, 701],
    "Resolved by D-003 — fix (tenant isolation) in Kotlin, with a test.")
res([402, 603, 515, 503, 602, 309, 513, 514, 216, 416, 610, 614, 119, 303, 203, 502, 702],
    "Resolved by D-002 — fix (invalid input must not cause 500 / empty response), with a test.")
res([611, 612], "Preserved behaviour (valid input) per D-002 unless it crashes; no 500 observed.")
res([5, 509, 510, 802, 617, 608], "Resolved by D-006 — not ported (framework/dev routes, Sidekiq Web replaced by JobRunr dashboard, OpenAPI 3 at same URL).")
res([405, 202, 120], "Resolved by D-007 — instance-wide APP_TIME_ZONE (default Europe/Warsaw).")
res([201, 206, 800, 801, 803, 804, 221], "Resolved by D-008 — fix scheduling/retry/reaper/locking defects.")
res([406, 407, 409, 413, 414, 412, 415, 410, 417], "Resolved by D-009 — keep current analytics/cash semantics (parity).")
res([306, 307, 312, 316, 318, 816, 504, 317, 319, 321, 322, 820], "Resolved by D-010 — keep exact LLM behaviour (parity).")
res([600, 601, 104, 400, 401, 403, 404, 301, 305, 607, 606], "Resolved by D-011 — fix (recorded deviation, with a test).")
res([223, 507, 808, 812, 517, 813, 219, 519, 819, 313, 520, 211, 212, 817, 123],
    "Resolved by D-012 — exact parity now; listed in the post-migration hardening backlog.")
res([215, 213, 214], "Resolved by D-013 — keep data-exchange scope and behaviour.")
res([314, 408], "Resolved by D-014 — documentation-only feature, out of scope.")
res([411], "Resolved by D-015 — hidden categories remain UI-only.")
res([110], "Resolved by D-016 — no user-deletion feature.")
res([109, 315], "Resolved by D-017 — keep overwrite-on-reseed behaviour.")
res([210, 805], "Resolved by D-018 — reject inverted sync windows (400 / alert).")
res([2, 3, 6], "No decision needed (investigation environment).")
res([4], "Open: needs Enable Banking sandbox + real LLM key run before cut-over (not a decision).")

themes = [
    ("T1 Target stack & migration approach", "001, 106, 818, 107, 516", "D-001, D-005"),
    ("T2 Bug-parity policy", "all BUG? entries", "D-002 (+ classification table in decisions.md)"),
    ("T3 Tenant isolation / multi-user leaks", "100, 300, 700, 712, 101, 200, 506, 121, 500, 811, 501, 810, 320, 524, 604, 209, 605, 806, 512, 304, 505, 521, 701, 411", "D-003 (fix); U-411 → D-015"),
    ("T4 Invalid input → 500 / missing validation", "402, 603, 515, 503, 602, 309, 513, 514, 216, 416, 610, 611, 612, 614, 210, 805, 203, 502, 702", "D-002 (fix), D-018"),
    ("T5 Time zones & scheduling", "120, 202, 405, 201, 221, 206, 800, 801, 803, 804, 204, 205", "D-007, D-008; U-204/U-205 open (preserve)"),
    ("T6 Analytics & cash semantics", "406, 407, 409, 410, 412, 413, 414, 415, 417, 104, 400, 401, 403, 404", "D-009 (keep), D-011 (fix ATM/cash API)"),
    ("T7 Classification & LLM behaviour", "301, 302, 303, 119, 305, 116, 118, 306, 307, 308, 310, 311, 313, 525, 316, 317, 319, 321, 322, 323, 820", "D-010 (keep LLM), D-011 (slug fixes); others preserved"),
    ("T8 Privacy & security posture", "312, 816, 219, 519, 220, 223, 507, 808, 520, 819, 812, 517, 813, 211, 212, 606, 817, 123", "D-012 (parity, hardening backlog), D-010, D-011 (U-606)"),
    ("T9 Data lifecycle, seeds, import/export", "109, 315, 110, 213, 214, 215, 217, 218, 821, 105, 108, 115, 208, 207, 103, 122", "D-013, D-016, D-017; rest preserved"),
    ("T10 Scope: framework/unused/dev & documentation-only features", "005, 509, 510, 802, 314, 408, 616, 511, 522, 523, 617, 608, 609, 613, 615, 607, 600, 601, 707", "D-006, D-014, D-011; rest preserved"),
    ("T11 Operations: mail, observability, deployment", "508, 807, 809, 822, 814, 815, 222, 518, 004", "open — operator topics, preserve (no decision requested)"),
    ("T12 UI details", "703, 704, 705, 706, 708, 709, 710, 711", "preserve (D-004 page contract); U-706 is an oracle-capture note"),
    ("T13 Investigation environment", "002, 003, 006", "no decision needed"),
]
DEFAULT = "Open — preserved behaviour by default (D-002: valid-input behaviour is kept unless a decision says otherwise)."
out = []
for k in sorted(entries):
    e = entries[k]
    r = " ".join(R.get(k, [DEFAULT]))
    out.append(e.rstrip() + f"\n- **Resolution:** {r}\n")
resolved = sum(1 for k in entries if k in R and not R[k][0].startswith("Open"))
hdr = f"""# Unknowns — open questions

> {len(entries)} entries ({resolved} resolved by a decision, the rest default to preserved behaviour). Numbering by area: U-001–099 investigator/environment ·
> U-100–149 domain & data · U-200–249 identity/banking/sync · U-300–349 classification/LLM · U-400–449 cash/ledger/analytics · U-500–549 Rails routes ·
> U-600–649 REST API/MCP · U-700–749 UI · U-800–849 async/integrations/security. **BUG?** marks suspected defects. Several areas found the same
> issue independently — the theme index groups duplicates. Each entry: what is unclear, evidence for/against, who/what can resolve, whether it
> needs a human, proposed default, and its **Resolution** (decision id in [decisions.md](decisions.md)).

## Theme index

| Theme | Entries | Resolution |
|---|---|---|
""" + "".join(f"| {t} | {ids} | {r} |\n" for t, ids, r in themes) + """
## Things that could not be exercised in the oracle (and why)

See U-004 (external systems only through fakes), U-005 (framework routes, real bank callback with valid state, password reset with a real
token), U-706 (UI captures that depend on interactive state), plus the "Not covered" notes at the end of 30-http-api.md sections marked [I].

## Post-migration backlog (decided: parity now, change later)

D-009 analytics semantics (U-406, U-407, U-409, U-413), D-010 LLM privacy/overwrite behaviour (U-306, U-312, U-318, U-816), D-012 security
hardening (U-223, U-507, U-808, U-812, U-813, U-219, U-519, U-819, U-313, U-520), D-017 re-seed overwrite (U-109, U-315).

## Entries

"""
open(D + "/unknowns.md", "w").write(hdr + "\n".join(out))
print(len(entries), "entries,", resolved, "resolved")
