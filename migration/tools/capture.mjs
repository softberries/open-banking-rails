// Runtime oracle capture. Usage: node capture.mjs <baseURL> <fixture.json> <outDir> <phase>
// phase = main | setup   (setup runs after users are truncated, to capture first-run flow)
import { chromium, request } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [BASE, FIXTURE, OUT, PHASE = "main"] = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const PEM = fs.readFileSync(new URL("./test_key.pem", import.meta.url), "utf8");
const HTTP = path.join(OUT, "http");
const UI = path.join(OUT, "ui");
fs.mkdirSync(HTTP, { recursive: true });
fs.mkdirSync(UI, { recursive: true });
const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = new Date(); const FROM = iso(new Date(Date.now() - 100 * 864e5)); const TO = iso(TODAY);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const KEEP_RES_HEADERS = ["content-type", "location", "cache-control", "www-authenticate", "x-frame-options",
  "x-content-type-options", "content-security-policy", "content-disposition", "mcp-session-id", "vary",
  "access-control-allow-origin", "access-control-allow-methods", "x-request-id", "retry-after", "content-length"];
const log = [];
const store = new Map(); // file -> {route, cases:[]}

function fileFor(verb, route) {
  const p = route.replace(/\(\.:format\)|\(\.json\)/g, "").replace(/^\//, "").replace(/[/:*.?]/g, "_") || "root";
  return `${verb.toUpperCase()}_${p}.json`;
}
function truncate(s, n = 4000) { return s.length > n ? s.slice(0, n) + `…[truncated ${s.length - n} chars]` : s; }
function redactReq(h) {
  const o = { ...h };
  if (o.authorization) o.authorization = o.authorization.replace(/(obrl_oracle_\w{6})\w+/, "$1…");
  if (o.cookie) o.cookie = "<session cookie>";
  return o;
}

async function rec(ctx, { verb, route, path: p, actor, caseName, headers = {}, form, json, multipart, data, note }) {
  verb = verb.toUpperCase();
  const opts = { method: verb, headers: { "user-agent": UA, ...headers }, maxRedirects: 0, failOnStatusCode: false, timeout: 60000 };
  if (form) opts.form = form;
  if (json !== undefined) { opts.data = JSON.stringify(json); opts.headers["content-type"] = "application/json"; }
  if (multipart) opts.multipart = multipart;
  if (data !== undefined) opts.data = data;
  let res, body = "", status = 0, rh = {};
  const t0 = Date.now();
  try {
    res = await ctx.fetch(p, opts);
    status = res.status();
    rh = res.headers();
    const ct = rh["content-type"] || "";
    if (/octet-stream/.test(ct)) { const b = await res.body(); body = `<binary ${b.length} bytes>`; }
    else body = await res.text();
  } catch (e) { body = `CLIENT ERROR: ${e.message}`; }
  const ms = Date.now() - t0;
  let parsed;
  if ((rh["content-type"] || "").includes("json")) { try { parsed = JSON.parse(body); } catch {} }
  const keptHeaders = Object.fromEntries(Object.entries(rh).filter(([k]) => KEEP_RES_HEADERS.includes(k)));
  if (rh["set-cookie"]) keptHeaders["set-cookie"] = rh["set-cookie"].split("\n").map(c => c.split("=")[0] + "=<redacted>; " + c.split(";").slice(1).join(";").trim());
  let bodySample = parsed !== undefined ? parsed : truncate(body);
  if (typeof bodySample === "object") { const s = JSON.stringify(bodySample); if (s.length > 12000) bodySample = truncate(s, 12000); }
  if (typeof bodySample === "string" && /<html/i.test(bodySample)) {
    const title = (body.match(/<title>([^<]*)<\/title>/i) || [])[1];
    const flash = [...body.matchAll(/data-flash[^>]*>([\s\S]*?)<\/|role="alert"[^>]*>([\s\S]*?)<\//g)].map(m => (m[1] || m[2] || "").replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 5);
    const h1 = (body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    bodySample = { html_title: title, h1: h1 && h1.replace(/<[^>]+>/g, "").trim(), flash, length: body.length, head: truncate(body.replace(/\s+/g, " "), 1500) };
  }
  const entry = {
    case: caseName || "default", actor, note,
    request: { method: verb, path: p, headers: redactReq(Object.fromEntries(Object.entries(opts.headers).filter(([k]) => k !== "user-agent"))),
      body: form ? redactForm(form) : json !== undefined ? (json && typeof json === 'object' && !Array.isArray(json) ? redactForm(json) : json) : multipart ? Object.keys(multipart) : data },
    response: { status, duration_ms: ms, headers: keptHeaders, body_sample: bodySample },
  };
  const f = fileFor(verb, route);
  if (!store.has(f)) store.set(f, { route: `${verb} ${route}`, captured_at: new Date().toISOString(), base_url: BASE, cases: [] });
  store.get(f).cases.push(entry);
  log.push(`${status} ${verb} ${p} [${actor}/${caseName || "default"}]`);
  return { status, body, headers: rh, json: parsed };
}
function redactForm(f) { const o = { ...f }; for (const k of Object.keys(o)) if (/password|authenticity_token|api_key|private_key/i.test(k)) o[k] = "<redacted>"; return o; }
function flush() {
  for (const [f, v] of store) fs.writeFileSync(path.join(HTTP, f), JSON.stringify(v, null, 2));
  fs.writeFileSync(path.join(OUT, `capture_log_${PHASE}.txt`), log.join("\n") + "\n");
}

async function csrfFrom(ctx, p = "/admin/sign_in") {
  const r = await ctx.fetch(p, { headers: { "user-agent": UA }, maxRedirects: 5 });
  const html = await r.text();
  const m = html.match(/name="csrf-token" content="([^"]+)"/) || html.match(/name="authenticity_token" value="([^"]+)"/);
  return m ? m[1] : "";
}
async function login(ctx, email, password) {
  const token = await csrfFrom(ctx, "/admin/sign_in");
  const r = await ctx.fetch("/admin/sign_in", { method: "POST", headers: { "user-agent": UA }, form: { authenticity_token: token, "user[email]": email, "user[password]": password }, maxRedirects: 0 });
  return r.status();
}
const T = (ctx) => csrfFrom(ctx, "/admin/settings/preferences/profile");

// ---------------------------------------------------------------------------------------------
async function phaseMain() {
  const anon = await request.newContext({ baseURL: BASE });
  const main = await request.newContext({ baseURL: BASE });
  const other = await request.newContext({ baseURL: BASE });
  const M = fx.main, O = fx.other;
  const tokM = { authorization: `Bearer ${fx.tokens.main}` };
  const tokO = { authorization: `Bearer ${fx.tokens.other}` };
  const tokR = { authorization: `Bearer ${fx.tokens.revoked}` };
  const tokBad = { authorization: "Bearer obrl_not_a_real_token" };

  // ---- anonymous / public -------------------------------------------------------------------
  await rec(anon, { verb: "GET", route: "/up(.:format)", path: "/up", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/", path: "/", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/admin(.:format)", path: "/admin", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/admin/analytics(.:format)", path: "/admin/analytics", actor: "anon", caseName: "anonymous_redirects_to_sign_in" });
  await rec(anon, { verb: "GET", route: "/admin/analytics(.:format)", path: "/admin/analytics", actor: "anon", caseName: "legacy_browser_ua", headers: { "user-agent": "Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko" }, note: "allow_browser versions: :modern" });
  await rec(anon, { verb: "GET", route: "/setup(.:format)", path: "/setup", actor: "anon", caseName: "users_exist" });
  let t = await csrfFrom(anon);
  await rec(anon, { verb: "POST", route: "/setup(.:format)", path: "/setup", actor: "anon", caseName: "users_exist", form: { authenticity_token: t, "user[name]": "X", "user[email]": "x@example.com", "user[password]": "Password123!", "user[password_confirmation]": "Password123!" } });
  await rec(anon, { verb: "GET", route: "/admin/sign_in(.:format)", path: "/admin/sign_in", actor: "anon" });
  t = await csrfFrom(anon);
  await rec(anon, { verb: "POST", route: "/admin/sign_in(.:format)", path: "/admin/sign_in", actor: "anon", caseName: "wrong_password", form: { authenticity_token: t, "user[email]": fx.users.main.email, "user[password]": "nope" } });
  await rec(anon, { verb: "POST", route: "/admin/sign_in(.:format)", path: "/admin/sign_in", actor: "anon", caseName: "missing_csrf_token", form: { "user[email]": fx.users.main.email, "user[password]": "nope" } });
  await rec(anon, { verb: "GET", route: "/admin/password/new(.:format)", path: "/admin/password/new", actor: "anon" });
  t = await csrfFrom(anon, "/admin/password/new");
  await rec(anon, { verb: "POST", route: "/admin/password(.:format)", path: "/admin/password", actor: "anon", caseName: "unknown_email", form: { authenticity_token: t, "user[email]": "nobody@example.com" } });
  t = await csrfFrom(anon, "/admin/password/new");
  await rec(anon, { verb: "POST", route: "/admin/password(.:format)", path: "/admin/password", actor: "anon", caseName: "known_email", form: { authenticity_token: t, "user[email]": fx.users.other.email } });
  await rec(anon, { verb: "GET", route: "/admin/password/edit(.:format)", path: "/admin/password/edit", actor: "anon", caseName: "no_token" });
  await rec(anon, { verb: "GET", route: "/admin/password/edit(.:format)", path: "/admin/password/edit?reset_password_token=bogus", actor: "anon", caseName: "bogus_token" });
  t = await csrfFrom(anon, "/admin/password/new");
  await rec(anon, { verb: "PATCH", route: "/admin/password(.:format)", path: "/admin/password", actor: "anon", caseName: "bogus_token", form: { authenticity_token: t, "user[reset_password_token]": "bogus", "user[password]": "Password123!", "user[password_confirmation]": "Password123!" } });
  t = await csrfFrom(anon, "/admin/password/new");
  await rec(anon, { verb: "PUT", route: "/admin/password(.:format)", path: "/admin/password", actor: "anon", caseName: "bogus_token", form: { authenticity_token: t, "user[reset_password_token]": "bogus", "user[password]": "short", "user[password_confirmation]": "x" } });
  await rec(anon, { verb: "DELETE", route: "/admin/sign_out(.:format)", path: "/admin/sign_out", actor: "anon", caseName: "not_signed_in", form: { authenticity_token: t } });
  await rec(anon, { verb: "GET", route: "/callback(.:format)", path: "/callback", actor: "anon", caseName: "anonymous_no_params" });
  await rec(anon, { verb: "GET", route: "/sidekiq", path: "/sidekiq", actor: "anon", caseName: "anonymous" });
  for (const r of ["/recede_historical_location", "/resume_historical_location", "/refresh_historical_location"])
    await rec(anon, { verb: "GET", route: r + "(.:format)", path: r, actor: "anon" });
  await rec(anon, { verb: "GET", route: "/api/:version/docs(.:format)", path: "/api/v1/docs", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/api/:version/docs(.:format)", path: "/api/v9/docs", actor: "anon", caseName: "unknown_version" });
  await rec(anon, { verb: "GET", route: "/api/:version/swagger_doc(.:format)", path: "/api/v1/swagger_doc", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/api/:version/swagger_doc/:name(.:format)", path: "/api/v1/swagger_doc/merchants", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/api/:version/swagger_doc/:name(.:format)", path: "/api/v1/swagger_doc/nope", actor: "anon", caseName: "unknown_name" });
  await rec(anon, { verb: "GET", route: "/api/:version/merchants(.json)", path: "/api/v1/nope", actor: "anon", caseName: "unknown_api_path_404", note: "not a merchants call: shows Grape 404 for an unmatched path" });
  // ActionMailbox ingresses + conductor + ActiveStorage: framework routes (invalid input only)
  for (const r of ["postmark", "relay", "sendgrid", "mandrill"])
    await rec(anon, { verb: "POST", route: `/rails/action_mailbox/${r}/inbound_emails(.:format)`, path: `/rails/action_mailbox/${r}/inbound_emails`, actor: "anon", data: "x", headers: { "content-type": "message/rfc822" } });
  await rec(anon, { verb: "GET", route: "/rails/action_mailbox/mandrill/inbound_emails(.:format)", path: "/rails/action_mailbox/mandrill/inbound_emails", actor: "anon" });
  await rec(anon, { verb: "POST", route: "/rails/action_mailbox/mailgun/inbound_emails/mime(.:format)", path: "/rails/action_mailbox/mailgun/inbound_emails/mime", actor: "anon", form: { x: "1" } });
  await rec(anon, { verb: "GET", route: "/rails/conductor/action_mailbox/inbound_emails(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/rails/conductor/action_mailbox/inbound_emails/new(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails/new", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/rails/conductor/action_mailbox/inbound_emails/:id(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails/999", actor: "anon" });
  await rec(anon, { verb: "GET", route: "/rails/conductor/action_mailbox/inbound_emails/sources/new(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails/sources/new", actor: "anon" });
  await rec(anon, { verb: "POST", route: "/rails/conductor/action_mailbox/inbound_emails(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails", actor: "anon", caseName: "no_csrf", form: { x: "1" } });
  await rec(anon, { verb: "POST", route: "/rails/conductor/action_mailbox/inbound_emails/sources(.:format)", path: "/rails/conductor/action_mailbox/inbound_emails/sources", actor: "anon", caseName: "no_csrf", form: { x: "1" } });
  await rec(anon, { verb: "POST", route: "/rails/conductor/action_mailbox/:inbound_email_id/reroute(.:format)", path: "/rails/conductor/action_mailbox/999/reroute", actor: "anon", caseName: "no_csrf", form: { x: "1" } });
  await rec(anon, { verb: "POST", route: "/rails/conductor/action_mailbox/:inbound_email_id/incinerate(.:format)", path: "/rails/conductor/action_mailbox/999/incinerate", actor: "anon", caseName: "no_csrf", form: { x: "1" } });
  for (const [r, p] of [
    ["/rails/active_storage/blobs/redirect/:signed_id/*filename(.:format)", "/rails/active_storage/blobs/redirect/bogus/x.png"],
    ["/rails/active_storage/blobs/proxy/:signed_id/*filename(.:format)", "/rails/active_storage/blobs/proxy/bogus/x.png"],
    ["/rails/active_storage/blobs/:signed_id/*filename(.:format)", "/rails/active_storage/blobs/bogus/x.png"],
    ["/rails/active_storage/representations/redirect/:signed_blob_id/:variation_key/*filename(.:format)", "/rails/active_storage/representations/redirect/bogus/bogus/x.png"],
    ["/rails/active_storage/representations/proxy/:signed_blob_id/:variation_key/*filename(.:format)", "/rails/active_storage/representations/proxy/bogus/bogus/x.png"],
    ["/rails/active_storage/representations/:signed_blob_id/:variation_key/*filename(.:format)", "/rails/active_storage/representations/bogus/bogus/x.png"],
    ["/rails/active_storage/disk/:encoded_key/*filename(.:format)", "/rails/active_storage/disk/bogus/x.png"]])
    await rec(anon, { verb: "GET", route: r, path: p, actor: "anon", caseName: "bogus_signed_id" });
  await rec(anon, { verb: "PUT", route: "/rails/active_storage/disk/:encoded_token(.:format)", path: "/rails/active_storage/disk/bogus", actor: "anon", caseName: "bogus_token", data: "x" });
  await rec(anon, { verb: "POST", route: "/rails/active_storage/direct_uploads(.:format)", path: "/rails/active_storage/direct_uploads", actor: "anon", caseName: "no_csrf", json: { blob: { filename: "x.txt", byte_size: 1, checksum: "x", content_type: "text/plain" } } });

  // ---- API: anonymous / bad tokens -------------------------------------------------------------
  await rec(anon, { verb: "GET", route: "/api/:version/merchants(.json)", path: "/api/v1/merchants", actor: "anon", caseName: "no_token" });
  await rec(anon, { verb: "GET", route: "/api/:version/merchants(.json)", path: "/api/v1/merchants", actor: "anon", caseName: "invalid_token", headers: tokBad });
  await rec(anon, { verb: "GET", route: "/api/:version/merchants(.json)", path: "/api/v1/merchants", actor: "anon", caseName: "revoked_token", headers: tokR });
  await rec(anon, { verb: "GET", route: "/api/:version/merchants(.json)", path: "/api/v1/merchants", actor: "main(token)", caseName: "cors_preflight_like_origin", headers: { ...tokM, origin: "https://evil.example" } });
  await rec(anon, { verb: "OPTIONS", route: "/api/:version/merchants(.json)", path: "/api/v1/merchants", actor: "anon", caseName: "cors_preflight", headers: { origin: "https://evil.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });

  // ---- MCP ----------------------------------------------------------------------------------------
  const mcpH = { accept: "application/json, text/event-stream" };
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "anon", caseName: "no_token", headers: mcpH, json: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "anon", caseName: "revoked_token", headers: { ...mcpH, ...tokR }, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  await rec(anon, { verb: "GET", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", headers: { ...mcpH, ...tokM } });
  await rec(anon, { verb: "DELETE", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", headers: { ...mcpH, ...tokM } });
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: "initialize", headers: { ...mcpH, ...tokM }, json: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oracle", version: "1" } } } });
  const tl = await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: "tools_list", headers: { ...mcpH, ...tokM }, json: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: "resources_list", headers: { ...mcpH, ...tokM }, json: { jsonrpc: "2.0", id: 3, method: "resources/list" } });
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: "unknown_method", headers: { ...mcpH, ...tokM }, json: { jsonrpc: "2.0", id: 4, method: "nope/nope" } });
  await rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: "malformed_json", headers: { ...mcpH, ...tokM, "content-type": "application/json" }, data: "{not json" });
  const mcpCall = async (name, args, caseSuffix = "") => rec(anon, { verb: "POST", route: "/mcp(.:format)", path: "/mcp", actor: "main(token)", caseName: `tools_call:${name}${caseSuffix}`, headers: { ...mcpH, ...tokM }, json: { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } } });
  const mcpTools = {
    "transactions.list": {}, "transactions.get": { source_type: "BankTransaction", source_id: M.bank_transaction_id },
    "categories.list": {}, "merchants.list": {}, "bank_accounts.list": {}, "bank_connections.list": {},
    "analytics.cash_flow": {}, "analytics.spend": {}, "analytics.top_merchants": {},
  };
  for (const [n, a] of Object.entries(mcpTools)) await mcpCall(n, a);
  await mcpCall("transactions.get", { source_type: "BankTransaction", source_id: O.bank_transaction_id }, ":other_tenant");
  await mcpCall("analytics.cash_flow", { bucket: "year" }, ":invalid_enum");
  const mcpCat = await mcpCall("categories.create", { name: "Oracle MCP Category" });
  await mcpCall("categories.create", { name: "" }, ":invalid");
  const mcpMer = await mcpCall("merchants.create", { name: "Oracle MCP Merchant" });
  const cashMcp = await mcpCall("cash.create_transaction", { amount: "12.34", currency: "PLN", direction: "debit", title: "MCP oracle cash" });
  await mcpCall("cash.create_transaction", { amount: "abc" }, ":invalid_amount");
  const idFrom = (r) => { try { const txt = r.json.result.content[0].text; const j = JSON.parse(txt); return j.id || (j.data && j.data.id) || (j.transaction && j.transaction.id); } catch { return null; } };
  const mcpCatId = idFrom(mcpCat), mcpMerId = idFrom(mcpMer), mcpCashId = idFrom(cashMcp);
  await mcpCall("categories.update", { id: mcpCatId, name: "Oracle MCP Category 2" });
  await mcpCall("categories.archive", { id: mcpCatId });
  await mcpCall("categories.unarchive", { id: mcpCatId });
  await mcpCall("merchants.update", { id: mcpMerId, notes: "updated via MCP" });
  await mcpCall("merchants.archive", { id: mcpMerId });
  await mcpCall("merchants.unarchive", { id: mcpMerId });
  await mcpCall("merchants.approve", { id: mcpMerId });
  await mcpCall("cash.update_transaction", { id: mcpCashId, title: "MCP oracle cash (edited)" });
  await mcpCall("transactions.classify", { bank_transaction_id: M.bank_transaction_id, mode: "only_this", merchant_id: M.merchant_id, category_id: M.category_id });
  await mcpCall("bank_accounts.refresh_balances", { id: M.bank_account_id });
  await mcpCall("bank_accounts.refresh_details", { id: M.bank_account_id });
  await mcpCall("bank_connections.refresh", { id: M.bank_connection_id });
  await mcpCall("transaction_syncs.create", { bank_connection_id: M.bank_connection_id });
  await mcpCall("llm_enrichments.create", { limit: 5 });
  await mcpCall("cash.delete_transaction", { id: mcpCashId });
  if (tl.json && tl.json.result) fs.writeFileSync(path.join(OUT, "mcp_tools_list.json"), JSON.stringify(tl.json.result, null, 2));

  // ---- API: authenticated reads (main) ------------------------------------------------------------
  const A = (verb, route, p, extra = {}) => rec(anon, { verb, route: `/api/:version${route}(.json)`, path: `/api/v1${p}`, actor: "main(token)", headers: tokM, ...extra });
  const AO = (verb, route, p, extra = {}) => rec(anon, { verb, route: `/api/:version${route}(.json)`, path: `/api/v1${p}`, actor: "main(token)", headers: tokM, caseName: "other_tenant_id", ...extra });
  await A("GET", "/transactions", "/transactions");
  await A("GET", "/transactions", "/transactions?direction=debit&limit=2&page=2", { caseName: "filtered_paged" });
  await A("GET", "/transactions", "/transactions?direction=sideways&from=notadate", { caseName: "invalid_params" });
  await A("GET", "/transactions", "/transactions?limit=1000", { caseName: "limit_above_max" });
  await A("GET", "/transactions/:source_type/:source_id", `/transactions/BankTransaction/${M.bank_transaction_id}`);
  await A("GET", "/transactions/:source_type/:source_id", `/transactions/ManualTransaction/${M.cash_transaction_id}`, { caseName: "manual" });
  await AO("GET", "/transactions/:source_type/:source_id", `/transactions/BankTransaction/${O.bank_transaction_id}`);
  await A("GET", "/transactions/:source_type/:source_id", `/transactions/Foo/1`, { caseName: "invalid_source_type" });
  await A("GET", "/cash_transactions", "/cash_transactions");
  await A("GET", "/cash_transactions/:id", `/cash_transactions/${M.cash_transaction_id}`);
  await AO("GET", "/cash_transactions/:id", `/cash_transactions/${O.cash_transaction_id}`);
  await A("GET", "/bank_transactions", "/bank_transactions?limit=3");
  await A("GET", "/bank_transactions/:id", `/bank_transactions/${M.bank_transaction_id}`);
  await AO("GET", "/bank_transactions/:id", `/bank_transactions/${O.bank_transaction_id}`);
  await A("GET", "/categories", "/categories");
  await A("GET", "/categories", "/categories?include_archived=true", { caseName: "include_archived" });
  await A("GET", "/categories/:id", `/categories/${M.category_id}`);
  await AO("GET", "/categories/:id", `/categories/${O.category_id}`);
  await A("GET", "/categories/:id", `/categories/abc`, { caseName: "non_integer_id" });
  await A("GET", "/merchants", "/merchants");
  await A("GET", "/merchants", "/merchants?q=bied&source=seed", { caseName: "filtered" });
  await A("GET", "/merchants", "/merchants?source=martian", { caseName: "invalid_enum" });
  await A("GET", "/merchants/:id", `/merchants/${M.merchant_id}`);
  await AO("GET", "/merchants/:id", `/merchants/${O.merchant_id}`);
  await A("GET", "/merchants/:merchant_id/rules", `/merchants/${M.rule_merchant_id}/rules`);
  await A("GET", "/bank_accounts", "/bank_accounts");
  await A("GET", "/bank_accounts", "/bank_accounts?manual=true", { caseName: "manual_only" });
  await A("GET", "/bank_accounts/:id", `/bank_accounts/${M.bank_account_id}`);
  await A("GET", "/bank_connections", "/bank_connections");
  await A("GET", "/bank_connections/:id", `/bank_connections/${M.bank_connection_id}`);
  await AO("GET", "/bank_connections/:id", `/bank_connections/${O.bank_connection_id}`);
  await A("GET", "/tpp_credentials", "/tpp_credentials");
  await A("GET", "/tpp_credentials/:id", `/tpp_credentials/${M.tpp_credential_id}`);
  await AO("GET", "/tpp_credentials/:id", `/tpp_credentials/${O.tpp_credential_id}`);
  await A("GET", "/transaction_syncs", "/transaction_syncs");
  await A("GET", "/transaction_syncs/:id", `/transaction_syncs/${M.operation_run_sync_id}`);
  await A("GET", "/llm_enrichments", "/llm_enrichments");
  await A("GET", "/analytics/cash_flow", "/analytics/cash_flow");
  await A("GET", "/analytics/cash_flow", `/analytics/cash_flow?from=${FROM}&to=${TO}&bucket=month&currency=PLN`, { caseName: "explicit_range" });
  await A("GET", "/analytics/cash_flow", "/analytics/cash_flow?bucket=year", { caseName: "invalid_bucket" });
  await A("GET", "/analytics/cash_flow", `/analytics/cash_flow?from=${TO}&to=${FROM}`, { caseName: "from_after_to" });
  await A("GET", "/analytics/spend", `/analytics/spend?from=${FROM}&to=${TO}&depth=2`);
  await A("GET", "/analytics/top_merchants", `/analytics/top_merchants?from=${FROM}&to=${TO}&limit=5`);
  await A("GET", "/analytics/categories/:slug", `/analytics/categories/${M.category_slug}?from=${FROM}&to=${TO}`);
  await A("GET", "/analytics/categories/:slug", `/analytics/categories/does-not-exist`, { caseName: "unknown_slug" });
  await A("GET", "/analytics/merchants/:slug", `/analytics/merchants/${M.merchant_slug}?from=${FROM}&to=${TO}`);
  await A("GET", "/analytics/merchants/:slug", `/analytics/merchants/does-not-exist`, { caseName: "unknown_slug" });

  // ---- API: writes (main) --------------------------------------------------------------------------
  const cat = await A("POST", "/categories", "/categories", { json: { name: "Oracle API Category", kind: "expense", parent_path: "food" } });
  await A("POST", "/categories", "/categories", { caseName: "missing_name", json: { kind: "expense" } });
  await A("POST", "/categories", "/categories", { caseName: "duplicate_slug", json: { name: "Food", slug: M.category_slug } });
  const catId = cat.json && (cat.json.id || (cat.json.data && cat.json.data.id));
  await A("PATCH", "/categories/:id", `/categories/${catId}`, { json: { name: "Oracle API Category Renamed", color: "#ff0000" } });
  await A("PATCH", "/categories/:id", `/categories/${catId}`, { caseName: "invalid_kind", json: { kind: "luxury" } });
  await AO("PATCH", "/categories/:id", `/categories/${O.category_id}`, { json: { name: "pwned" } });
  await A("POST", "/categories/:id/archive", `/categories/${catId}/archive`);
  await A("POST", "/categories/:id/unarchive", `/categories/${catId}/unarchive`);
  const mer = await A("POST", "/merchants", "/merchants", { json: { name: "Oracle API Merchant", kind: "company", default_category_id: catId } });
  await A("POST", "/merchants", "/merchants", { caseName: "missing_name", json: {} });
  await A("POST", "/merchants", "/merchants", { caseName: "foreign_category", json: { name: "Oracle Foreign Cat", default_category_id: O.category_id } });
  const merId = mer.json && (mer.json.id || (mer.json.data && mer.json.data.id));
  await A("PATCH", "/merchants/:id", `/merchants/${merId}`, { json: { notes: "edited" } });
  await A("POST", "/merchants/:id/archive", `/merchants/${merId}/archive`);
  await A("POST", "/merchants/:id/unarchive", `/merchants/${merId}/unarchive`);
  await A("POST", "/merchants/:id/approve", `/merchants/${merId}/approve`);
  const rule = await A("POST", "/merchants/:merchant_id/rules", `/merchants/${merId}/rules`, { json: { kind: "contains", field: "title", pattern: "ORACLE SHOP" } });
  await A("POST", "/merchants/:merchant_id/rules", `/merchants/${merId}/rules`, { caseName: "invalid_regex", json: { kind: "regex", field: "title", pattern: "([" } });
  await A("POST", "/merchants/:merchant_id/rules", `/merchants/${merId}/rules`, { caseName: "missing_required", json: { kind: "contains" } });
  const ruleId = rule.json && (rule.json.id || (rule.json.data && rule.json.data.id));
  await A("PATCH", "/merchants/:merchant_id/rules/:id", `/merchants/${merId}/rules/${ruleId}`, { json: { priority: 5, enabled: false } });
  const cash = await A("POST", "/cash_transactions", "/cash_transactions", { json: { amount: "25.50", currency: "PLN", direction: "debit", title: "Oracle API cash", booking_date: "2026-01-10" } });
  await A("POST", "/cash_transactions", "/cash_transactions", { caseName: "invalid_amount", json: { amount: "12,3x" } });
  await A("POST", "/cash_transactions", "/cash_transactions", { caseName: "missing_amount", json: { title: "x" } });
  await A("POST", "/cash_transactions", "/cash_transactions", { caseName: "currency_eur_lowercase", json: { amount: "1.005", currency: "eur", direction: "credit", title: "Oracle rounding probe" } });
  const cashId = cash.json && (cash.json.id || (cash.json.data && cash.json.data.id));
  await A("PATCH", "/cash_transactions/:id", `/cash_transactions/${cashId}`, { json: { title: "Oracle API cash edited", amount: "30" } });
  await A("PATCH", "/cash_transactions/:id", `/cash_transactions/${cashId}`, { caseName: "invalid_direction", json: { direction: "up" } });
  await A("POST", "/bank_transactions/:bank_transaction_id/classification", `/bank_transactions/${M.bank_transaction_id}/classification`, { json: { mode: "only_this", merchant_id: merId, category_id: catId } });
  await A("POST", "/bank_transactions/:bank_transaction_id/classification", `/bank_transactions/${M.bank_transaction_id}/classification`, { caseName: "create_rule_missing_pattern", json: { mode: "create_rule", merchant_id: merId } });
  await A("POST", "/bank_transactions/:bank_transaction_id/classification", `/bank_transactions/${M.bank_transaction_id}/classification`, { caseName: "invalid_mode", json: { mode: "everything" } });
  await A("POST", "/bank_accounts/:id/refresh_details", `/bank_accounts/${M.bank_account_id}/refresh_details`);
  await A("POST", "/bank_accounts/:id/refresh_balances", `/bank_accounts/${M.bank_account_id}/refresh_balances`);
  await A("PATCH", "/bank_connections/:id", `/bank_connections/${M.bank_connection_id}`, { json: { status: "bogus" }, caseName: "invalid_status" });
  await A("POST", "/bank_connections/:id/refresh", `/bank_connections/${M.bank_connection_id}/refresh`);
  const tpp = await A("POST", "/tpp_credentials", "/tpp_credentials", { json: { name: "Oracle TPP", environment: "SANDBOX", application_id: "00000000-0000-0000-0000-000000000000", redirect_url: "http://127.0.0.1:3000/callback", private_key_pem: PEM } });
  await A("POST", "/tpp_credentials", "/tpp_credentials", { caseName: "invalid_environment", json: { name: "Oracle TPP 2", environment: "STAGING" } });
  const tppId = tpp.json && (tpp.json.id || (tpp.json.data && tpp.json.data.id));
  await A("PATCH", "/tpp_credentials/:id", `/tpp_credentials/${tppId}`, { json: { name: "Oracle TPP renamed" } });
  await A("POST", "/tpp_credentials/:id/test_connection", `/tpp_credentials/${M.tpp_credential_id}/test_connection`);
  await A("POST", "/tpp_credentials/:id/test_connection", `/tpp_credentials/${tppId}/test_connection`, { caseName: "incomplete_credential" });
  await A("POST", "/tpp_credentials/:id/make_primary", `/tpp_credentials/${tppId}/make_primary`);
  await A("POST", "/tpp_credentials/:id/make_primary", `/tpp_credentials/${M.tpp_credential_id}/make_primary`, { caseName: "restore_primary" });
  await A("POST", "/transaction_syncs", "/transaction_syncs", { json: { bank_connection_id: M.bank_connection_id, date_from: FROM, date_to: TO } });
  await A("POST", "/transaction_syncs", "/transaction_syncs", { caseName: "date_to_before_from", json: { bank_connection_id: M.bank_connection_id, date_from: TO, date_to: FROM } });
  await A("POST", "/transaction_syncs", "/transaction_syncs", { caseName: "other_tenant_connection", json: { bank_connection_id: O.bank_connection_id } });
  const llm = await A("POST", "/llm_enrichments", "/llm_enrichments", { json: { limit: 5 } });
  await A("POST", "/llm_enrichments", "/llm_enrichments", { caseName: "invalid_limit", json: { limit: "many" } });
  const llmId = llm.json && (llm.json.id || (llm.json.data && llm.json.data.id));
  await A("GET", "/llm_enrichments/:id", `/llm_enrichments/${llmId || M.operation_run_llm_id || 999999}`);
  await A("GET", "/llm_enrichments/:id", `/llm_enrichments/999999`, { caseName: "not_found" });
  // API deletes (own throwaway records)
  await A("DELETE", "/merchants/:merchant_id/rules/:id", `/merchants/${merId}/rules/${ruleId}`);
  await A("DELETE", "/cash_transactions/:id", `/cash_transactions/${cashId}`);
  await AO("DELETE", "/cash_transactions/:id", `/cash_transactions/${O.cash_transaction_id}`);
  await A("DELETE", "/merchants/:id", `/merchants/${merId}`);
  await A("DELETE", "/categories/:id", `/categories/${catId}`);
  await A("DELETE", "/categories/:id", `/categories/${M.category_id}`, { caseName: "category_in_use_or_with_children" });
  await A("DELETE", "/tpp_credentials/:id", `/tpp_credentials/${tppId}`);
  // bank connection destroy on the expired one is done last (see below)

  // ---- Admin (session) ----------------------------------------------------------------------------
  const ls1 = await login(main, fx.users.main.email, fx.users.main.password);
  const ls2 = await login(other, fx.users.other.email, fx.users.other.password);
  log.push(`login main=${ls1} other=${ls2}`);
  const G = (route, p, extra = {}) => rec(main, { verb: "GET", route: route + "(.:format)", path: p, actor: "main(session)", ...extra });
  const GX = (route, p, extra = {}) => rec(main, { verb: "GET", route: route + "(.:format)", path: p, actor: "main(session)", caseName: "other_tenant_id", ...extra });
  await rec(main, { verb: "GET", route: "/sidekiq", path: "/sidekiq", actor: "main(session)", caseName: "authenticated" });
  await G("/admin", "/admin");
  await G("/admin/analytics", "/admin/analytics");
  await G("/admin/analytics", `/admin/analytics?from=${FROM}&to=${TO}&currency=PLN`, { caseName: "explicit_range" });
  await G("/admin/analytics/categories/:slug", `/admin/analytics/categories/${M.category_slug}`);
  await G("/admin/analytics/categories/:slug", `/admin/analytics/categories/nope`, { caseName: "unknown_slug" });
  await G("/admin/analytics/merchants/:slug", `/admin/analytics/merchants/${M.merchant_slug}`);
  await G("/admin/styleguide", "/admin/styleguide");
  await G("/admin/versions", "/admin/versions");
  await G("/admin/versions/:id", `/admin/versions/${M.version_id}`);
  await rec(other, { verb: "GET", route: "/admin/versions(.:format)", path: "/admin/versions", actor: "other(session)", caseName: "other_tenant_sees_all_versions" });
  await rec(other, { verb: "GET", route: "/admin/versions/:id(.:format)", path: `/admin/versions/${M.version_id}`, actor: "other(session)", caseName: "other_tenant_reads_main_version" });
  await G("/admin/bank_transactions", "/admin/bank_transactions");
  await G("/admin/bank_transactions", "/admin/bank_transactions?enrichment_state=unclassified&payment_method=card&q[title_cont]=BIED", { caseName: "filtered" });
  await G("/admin/bank_transactions/:id", `/admin/bank_transactions/${M.bank_transaction_id}`);
  await GX("/admin/bank_transactions/:id", `/admin/bank_transactions/${O.bank_transaction_id}`);
  await G("/admin/cash_transactions", "/admin/cash_transactions");
  await G("/admin/cash_transactions/new", "/admin/cash_transactions/new");
  await G("/admin/cash_transactions/new", "/admin/cash_transactions/new?direction=credit", { caseName: "credit" });
  await G("/admin/cash_transactions/:id", `/admin/cash_transactions/${M.cash_transaction_id}`);
  await GX("/admin/cash_transactions/:id", `/admin/cash_transactions/${O.cash_transaction_id}`);
  await G("/admin/cash_transactions/:id/edit", `/admin/cash_transactions/${M.cash_transaction_id}/edit`);
  await G("/admin/categories", "/admin/categories");
  await G("/admin/categories/new", "/admin/categories/new?parent_path=food");
  await G("/admin/categories/:id/edit", `/admin/categories/${M.category_id}/edit`);
  await GX("/admin/categories/:id/edit", `/admin/categories/${O.category_id}/edit`);
  await G("/admin/merchants", "/admin/merchants");
  await G("/admin/merchants", "/admin/merchants?show_archived=1&source=seed&q=a", { caseName: "filtered" });
  await G("/admin/merchants/new", "/admin/merchants/new");
  await G("/admin/merchants/:id", `/admin/merchants/${M.merchant_id}`);
  await GX("/admin/merchants/:id", `/admin/merchants/${O.merchant_id}`);
  await G("/admin/merchants/:id/edit", `/admin/merchants/${M.merchant_id}/edit`);
  await G("/admin/llm_enrichments", "/admin/llm_enrichments");
  await G("/admin/llm_enrichments/:id", `/admin/llm_enrichments/${llmId || 999999}`);
  await G("/admin/matching_engine", "/admin/matching_engine");
  await G("/admin/transaction_syncs", "/admin/transaction_syncs");
  await G("/admin/transaction_syncs/new", "/admin/transaction_syncs/new");
  await G("/admin/transaction_syncs/:id", `/admin/transaction_syncs/${M.operation_run_sync_id}`);
  await G("/admin/tpp_credentials", "/admin/tpp_credentials");
  await G("/admin/tpp_credentials/new", "/admin/tpp_credentials/new");
  await G("/admin/tpp_credentials/:id", `/admin/tpp_credentials/${M.tpp_credential_id}`);
  await GX("/admin/tpp_credentials/:id", `/admin/tpp_credentials/${O.tpp_credential_id}`);
  await G("/admin/tpp_credentials/:id/edit", `/admin/tpp_credentials/${M.tpp_credential_id}/edit`);
  await G("/admin/bank_connections", "/admin/bank_connections");
  await G("/admin/bank_connections/new", "/admin/bank_connections/new");
  await G("/admin/bank_connections/new", "/admin/bank_connections/new?aspsp_name=PKO%20BP&aspsp_country=PL", { caseName: "with_aspsp" });
  await G("/admin/bank_connections/:id", `/admin/bank_connections/${M.bank_connection_id}`);
  await GX("/admin/bank_connections/:id", `/admin/bank_connections/${O.bank_connection_id}`);
  await G("/admin/bank_connections/:id/edit", `/admin/bank_connections/${M.bank_connection_id}/edit`);
  await G("/admin/bank_connections/:bank_connection_id/sync_schedule/edit", `/admin/bank_connections/${M.bank_connection_id}/sync_schedule/edit`);
  await G("/admin/bank_accounts", "/admin/bank_accounts");
  await G("/admin/bank_accounts/:id", `/admin/bank_accounts/${M.bank_account_id}`);
  await G("/admin/settings", "/admin/settings");
  await G("/admin/settings/preferences", "/admin/settings/preferences");
  await G("/admin/settings/preferences/profile", "/admin/settings/preferences/profile");
  await G("/admin/settings/preferences/app", "/admin/settings/preferences/app");
  await G("/admin/settings/preferences/llm", "/admin/settings/preferences/llm");
  await G("/admin/settings/preferences/data_exchange", "/admin/settings/preferences/data_exchange");
  await G("/admin/settings/preferences/api_tokens", "/admin/settings/preferences/api_tokens");
  await G("/admin/debug", "/admin/debug");
  for (const d of ["runtime_error", "zero_division", "argument_error", "nested_error"]) await G(`/admin/debug/${d}`, `/admin/debug/${d}`);
  await G("/callback", "/callback?error=access_denied", { caseName: "bank_error_param" });
  await G("/callback", "/callback?state=garbage&code=abc", { caseName: "invalid_state" });
  await G("/callback", "/callback?code=abc", { caseName: "missing_state" });
  await G("/admin/does-not-exist", "/admin/does-not-exist", { caseName: "unknown_route_404" });

  // ---- Admin mutations (main) ------------------------------------------------------------------
  const P = async (verb, route, p, form, extra = {}) => { const tk = await T(main); return rec(main, { verb, route: route + "(.:format)", path: p, actor: "main(session)", form: { authenticity_token: tk, ...form }, ...extra }); };
  await P("POST", "/admin/onboarding/seed_taxonomy", "/admin/onboarding/seed_taxonomy", {});
  const cc = await P("POST", "/admin/categories", "/admin/categories", { "category[name]": "Oracle UI Category", "category[kind]": "expense", "category[parent_path]": "food" });
  await P("POST", "/admin/categories", "/admin/categories", { "category[name]": "" }, { caseName: "invalid_blank_name" });
  const uiCatId = await apiFind(anon, tokM, "/api/v1/categories", x => x.name === "Oracle UI Category");
  await P("PATCH", "/admin/categories/:id", `/admin/categories/${uiCatId}`, { "category[name]": "Oracle UI Category 2", "category[color]": "#00ff00" });
  await P("PUT", "/admin/categories/:id", `/admin/categories/${uiCatId}`, { "category[kind]": "luxury" }, { caseName: "invalid_kind" });
  await P("POST", "/admin/categories/:id/archive", `/admin/categories/${uiCatId}/archive`, {});
  await P("POST", "/admin/categories/:id/unarchive", `/admin/categories/${uiCatId}/unarchive`, {});
  await P("POST", "/admin/merchants", "/admin/merchants", { "merchant[name]": "Oracle UI Merchant", "merchant[kind]": "company" });
  await P("POST", "/admin/merchants", "/admin/merchants", { "merchant[name]": "" }, { caseName: "invalid_blank_name" });
  const uiMerId = await apiFind(anon, tokM, "/api/v1/merchants?q=Oracle%20UI", x => x.name === "Oracle UI Merchant");
  await P("PATCH", "/admin/merchants/:id", `/admin/merchants/${uiMerId}`, { "merchant[notes]": "edited in UI" });
  await P("PUT", "/admin/merchants/:id", `/admin/merchants/${uiMerId}`, { "merchant[name]": "" }, { caseName: "invalid_blank_name" });
  await P("POST", "/admin/merchants/:id/archive", `/admin/merchants/${uiMerId}/archive`, {});
  await P("POST", "/admin/merchants/:id/unarchive", `/admin/merchants/${uiMerId}/unarchive`, {});
  await P("POST", "/admin/merchants/:id/approve", `/admin/merchants/${uiMerId}/approve`, {});
  await P("POST", "/admin/merchants/:merchant_id/merchant_rules", `/admin/merchants/${uiMerId}/merchant_rules`, { "merchant_rule[kind]": "contains", "merchant_rule[field]": "title", "merchant_rule[pattern]": "ORACLE UI SHOP" });
  await P("POST", "/admin/merchants/:merchant_id/merchant_rules", `/admin/merchants/${uiMerId}/merchant_rules`, { "merchant_rule[kind]": "regex", "merchant_rule[field]": "title", "merchant_rule[pattern]": "([" }, { caseName: "invalid_regex" });
  const uiRuleId = await apiFind(anon, tokM, `/api/v1/merchants/${uiMerId}/rules`, x => x.pattern === "ORACLE UI SHOP");
  await P("PATCH", "/admin/merchants/:merchant_id/merchant_rules/:id", `/admin/merchants/${uiMerId}/merchant_rules/${uiRuleId}`, { "merchant_rule[priority]": "3" });
  await P("PUT", "/admin/merchants/:merchant_id/merchant_rules/:id", `/admin/merchants/${uiMerId}/merchant_rules/${uiRuleId}`, { "merchant_rule[pattern]": "" }, { caseName: "invalid_blank_pattern" });
  await P("POST", "/admin/cash_transactions", "/admin/cash_transactions", { "cash_transaction[amount]": "10.00", "cash_transaction[currency]": "PLN", "cash_transaction[direction]": "debit", "cash_transaction[title]": "Oracle UI cash", "cash_transaction[booking_date]": "2026-01-12" });
  await P("POST", "/admin/cash_transactions", "/admin/cash_transactions", { "cash_transaction[amount]": "abc" }, { caseName: "invalid_amount" });
  const uiCashId = await apiFind(anon, tokM, "/api/v1/cash_transactions?limit=100", x => x.title === "Oracle UI cash");
  await P("PATCH", "/admin/cash_transactions/:id", `/admin/cash_transactions/${uiCashId}`, { "cash_transaction[title]": "Oracle UI cash edited" });
  await P("PUT", "/admin/cash_transactions/:id", `/admin/cash_transactions/${uiCashId}`, { "cash_transaction[amount]": "-" }, { caseName: "invalid_amount" });
  await P("PATCH", "/admin/bank_transactions/:bank_transaction_id/enrichment", `/admin/bank_transactions/${M.bank_transaction_id}/enrichment`, { "enrichment[mode]": "only_this", "enrichment[merchant_id]": String(M.merchant_id), "enrichment[category_id]": String(M.category_id) });
  await P("PUT", "/admin/bank_transactions/:bank_transaction_id/enrichment", `/admin/bank_transactions/${M.bank_transaction_id}/enrichment`, { "enrichment[mode]": "create_rule" }, { caseName: "create_rule_missing_fields" });
  await P("POST", "/admin/llm_enrichments", "/admin/llm_enrichments", { limit: "5" });
  await P("POST", "/admin/transaction_syncs", "/admin/transaction_syncs", { bank_connection_id: String(M.bank_connection_id), date_from: FROM, date_to: TO });
  await P("POST", "/admin/transaction_syncs", "/admin/transaction_syncs", { bank_connection_id: "" }, { caseName: "missing_connection" });
  await P("POST", "/admin/tpp_credentials", "/admin/tpp_credentials", { "tpp_credential[name]": "Oracle UI TPP", "tpp_credential[environment]": "SANDBOX", "tpp_credential[application_id]": "11111111-1111-1111-1111-111111111111", "tpp_credential[redirect_url]": "http://127.0.0.1:3000/callback", "tpp_credential[private_key_pem]": PEM });
  await P("POST", "/admin/tpp_credentials", "/admin/tpp_credentials", { "tpp_credential[name]": "" }, { caseName: "invalid_blank_name" });
  const uiTppId = await apiFind(anon, tokM, "/api/v1/tpp_credentials", x => x.name === "Oracle UI TPP");
  await P("PATCH", "/admin/tpp_credentials/:id", `/admin/tpp_credentials/${uiTppId}`, { "tpp_credential[name]": "Oracle UI TPP 2" });
  await P("PUT", "/admin/tpp_credentials/:id", `/admin/tpp_credentials/${uiTppId}`, { "tpp_credential[environment]": "STAGING" }, { caseName: "invalid_environment" });
  await P("POST", "/admin/tpp_credentials/:id/test_connection", `/admin/tpp_credentials/${M.tpp_credential_id}/test_connection`, {});
  await P("POST", "/admin/tpp_credentials/:id/make_primary", `/admin/tpp_credentials/${M.tpp_credential_id}/make_primary`, {});
  await P("POST", "/admin/bank_connections", "/admin/bank_connections", { "bank_connection_request_form[aspsp_name]": "PKO BP", "bank_connection_request_form[aspsp_country]": "PL", "bank_connection_request_form[psu_type]": "personal", "bank_connection_request_form[valid_days]": "90" }, { note: "starts bank authorisation; with fakes it returns a fake redirect URL" });
  await P("POST", "/admin/bank_connections", "/admin/bank_connections", { "bank_connection_request_form[aspsp_name]": "" }, { caseName: "invalid_blank_aspsp" });
  await P("PATCH", "/admin/bank_connections/:id", `/admin/bank_connections/${M.bank_connection_id}`, { "bank_connection[status]": "AUTHORIZED" });
  await P("PUT", "/admin/bank_connections/:id", `/admin/bank_connections/${M.bank_connection_id}`, { "bank_connection[status]": "BOGUS" }, { caseName: "invalid_status" });
  await P("POST", "/admin/bank_connections/:id/refresh", `/admin/bank_connections/${M.bank_connection_id}/refresh`, {});
  await P("POST", "/admin/bank_connections/:id/reauth", `/admin/bank_connections/${M.bank_connection_id}/reauth`, {});
  await P("PATCH", "/admin/bank_connections/:bank_connection_id/sync_schedule", `/admin/bank_connections/${M.bank_connection_id}/sync_schedule`, { "sync_schedule[enabled]": "1", "sync_schedule[cadence]": "daily", "sync_schedule[preferred_hour]": "6" });
  await P("PUT", "/admin/bank_connections/:bank_connection_id/sync_schedule", `/admin/bank_connections/${M.bank_connection_id}/sync_schedule`, { "sync_schedule[cadence]": "hourly", "sync_schedule[preferred_hour]": "99" }, { caseName: "invalid" });
  await P("POST", "/admin/bank_accounts/:id/refresh_details", `/admin/bank_accounts/${M.bank_account_id}/refresh_details`, {});
  await P("POST", "/admin/bank_accounts/:id/refresh_balances", `/admin/bank_accounts/${M.bank_account_id}/refresh_balances`, {});
  await P("PATCH", "/admin/settings/preferences/profile", "/admin/settings/preferences/profile", { "user[name]": "John Doe (oracle)" });
  await P("PATCH", "/admin/settings/preferences/profile", "/admin/settings/preferences/profile", { "user[name]": "" }, { caseName: "invalid_blank_name" });
  await P("PATCH", "/admin/settings/preferences/password", "/admin/settings/preferences/password", { "user[current_password]": "wrong", "user[password]": "NewPassword123!", "user[password_confirmation]": "NewPassword123!" }, { caseName: "wrong_current_password" });
  await P("PATCH", "/admin/settings/preferences/password", "/admin/settings/preferences/password", { "user[current_password]": fx.users.main.password, "user[password]": "short", "user[password_confirmation]": "short" }, { caseName: "too_short" });
  await P("PATCH", "/admin/settings/preferences/app", "/admin/settings/preferences/app", { "user[track_cash]": "1", "user[reveal_hidden_categories]": "0" });
  await P("PATCH", "/admin/settings/preferences/llm", "/admin/settings/preferences/llm", { "llm_setting[provider]": "openai", "llm_setting[model]": "gpt-5-mini" }, { note: "api_key left blank (keep existing)" });
  await P("PATCH", "/admin/settings/preferences/llm", "/admin/settings/preferences/llm", { "llm_setting[provider]": "martian", "llm_setting[model]": "" }, { caseName: "invalid_provider" });
  await P("POST", "/admin/settings/preferences/llm/test", "/admin/settings/preferences/llm/test", {});
  await P("POST", "/admin/settings/preferences/api_tokens", "/admin/settings/preferences/api_tokens", { "personal_access_token[name]": "oracle-ui-token", name: "oracle-ui-token" });
  await P("POST", "/admin/settings/preferences/api_tokens", "/admin/settings/preferences/api_tokens", { "personal_access_token[name]": "", name: "" }, { caseName: "invalid_blank_name" });
  const uiTokId = await lookupId(main, "/admin/settings/preferences/api_tokens", /\/admin\/settings\/preferences\/api_tokens\/(\d+)/);
  log.push(`ids cat=${uiCatId} mer=${uiMerId} rule=${uiRuleId} cash=${uiCashId} tpp=${uiTppId} tok=${uiTokId}`);
  await P("POST", "/admin/settings/preferences/data_exchange/export", "/admin/settings/preferences/data_exchange/export", { passphrase: "oracle-passphrase" });
  await P("POST", "/admin/settings/preferences/data_exchange/export", "/admin/settings/preferences/data_exchange/export", { passphrase: "" }, { caseName: "blank_passphrase" });
  await P("POST", "/admin/settings/preferences/data_exchange/import", "/admin/settings/preferences/data_exchange/import", { passphrase: "x" }, { caseName: "missing_bundle" });
  { const tk = await T(main); await rec(main, { verb: "POST", route: "/admin/settings/preferences/data_exchange/import(.:format)", path: "/admin/settings/preferences/data_exchange/import", actor: "main(session)", caseName: "garbage_bundle", multipart: { authenticity_token: tk, passphrase: "x", strategy: "skip_existing", bundle: { name: "x.obrbundle", mimeType: "application/octet-stream", buffer: Buffer.from("not a bundle") } } }); }
  await P("POST", "/admin/debug/enqueue_failing_job", "/admin/debug/enqueue_failing_job", { error_type: "runtime" });
  // CSRF probe on an admin mutation
  await rec(main, { verb: "POST", route: "/admin/categories(.:format)", path: "/admin/categories", actor: "main(session)", caseName: "missing_csrf_token", form: { "category[name]": "CSRF probe" } });
  // cross-tenant mutations (expect 404)
  await P("PATCH", "/admin/merchants/:id", `/admin/merchants/${O.merchant_id}`, { "merchant[name]": "pwned" }, { caseName: "other_tenant_id" });
  await P("DELETE", "/admin/categories/:id", `/admin/categories/${O.category_id}`, {}, { caseName: "other_tenant_id" });
  // destructive (own throwaway records)
  await P("DELETE", "/admin/settings/preferences/api_tokens/:id", `/admin/settings/preferences/api_tokens/${uiTokId}`, {}, { caseName: "first_delete_revokes" });
  await P("DELETE", "/admin/settings/preferences/api_tokens/:id", `/admin/settings/preferences/api_tokens/${uiTokId}`, {}, { caseName: "second_delete_destroys_revoked" });
  await P("DELETE", "/admin/merchants/:merchant_id/merchant_rules/:id", `/admin/merchants/${uiMerId}/merchant_rules/${uiRuleId}`, {});
  await P("DELETE", "/admin/cash_transactions/:id", `/admin/cash_transactions/${uiCashId}`, {});
  await P("DELETE", "/admin/merchants/:id", `/admin/merchants/${uiMerId}`, {});
  await P("DELETE", "/admin/categories/:id", `/admin/categories/${uiCatId}`, {});
  await P("DELETE", "/admin/tpp_credentials/:id", `/admin/tpp_credentials/${uiTppId}`, {});
  // destroy the expired connection of the main tenant (API) and another via admin? keep main active connection.
  await P("DELETE", "/admin/bank_connections/:id", `/admin/bank_connections/${O.bank_connection_id}`, {}, { caseName: "other_tenant_id" });
  // finally sign-in valid + sign-out
  t = await csrfFrom(anon);
  await rec(anon, { verb: "POST", route: "/admin/sign_in(.:format)", path: "/admin/sign_in", actor: "anon", caseName: "valid_credentials", form: { authenticity_token: t, "user[email]": fx.users.other.email, "user[password]": fx.users.other.password } });
  t = await T(anon);
  await rec(anon, { verb: "DELETE", route: "/admin/sign_out(.:format)", path: "/admin/sign_out", actor: "other(session)", caseName: "signed_in", form: { authenticity_token: t } });
  flush();

  // ---- UI screenshots -------------------------------------------------------------------------------
  await screenshots(llmId);
  // destructive bank-connection deletes run AFTER screenshots so pages keep their data
  await rec(anon, { verb: "GET", route: "/api/:version/bank_connections(.json)", path: "/api/v1/bank_connections?status=authorized", actor: "main(token)", headers: tokM, caseName: "status_filter_authorized" });
  const t2 = await T(main);
  await rec(main, { verb: "DELETE", route: "/admin/bank_connections/:id(.:format)", path: `/admin/bank_connections/${M.bank_connection_id + 1}`, actor: "main(session)", caseName: "own_connection", form: { authenticity_token: t2 }, note: "destroys main tenant's 2nd connection (Revolut)" });
  await A("DELETE", "/bank_connections/:id", `/bank_connections/${M.bank_connection_id}`, { note: "destroys main tenant's 1st connection (PKO) - last call of the run" });
  await A("DELETE", "/bank_connections/:id", `/bank_connections/${O.bank_connection_id}`, { caseName: "other_tenant_id" });
  flush();
}

async function apiFind(ctx, h, p, pred) {
  const r = await ctx.fetch(p, { headers: { "user-agent": UA, ...h } });
  let j; try { j = await r.json(); } catch { return "0"; }
  const arr = Array.isArray(j) ? j : (j.data || j.items || j.results || Object.values(j).find(Array.isArray) || []);
  const hit = arr.find(pred); return hit ? hit.id : "0";
}
async function lookupId(ctx, p, re) {
  const r = await ctx.fetch(p, { headers: { "user-agent": UA } });
  const m = (await r.text()).match(re);
  return m ? m[1] : "0";
}

async function shoot(page, name, url, { actions } = {}) {
  try {
    const resp = await page.goto(BASE + url, { waitUntil: "networkidle", timeout: 45000 });
    if (actions) await actions(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(UI, `${name}.png`), fullPage: true });
    fs.writeFileSync(path.join(UI, `${name}.html`), await page.content());
    log.push(`UI ${resp ? resp.status() : "?"} ${name} ${url} -> ${page.url()}`);
  } catch (e) { log.push(`UI FAIL ${name} ${url}: ${e.message.split("\n")[0]}`); }
}

async function screenshots(llmId) {
  const M = fx.main;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`); });
  await shoot(page, "admin_sign_in", "/admin/sign_in");
  await shoot(page, "admin_password_new", "/admin/password/new");
  await shoot(page, "setup_redirect_when_users_exist", "/setup");
  await page.goto(BASE + "/admin/sign_in");
  await page.fill("input[name='user[email]']", "maciek@example.com");
  await page.fill("input[name='user[password]']", "nope");
  await Promise.all([page.waitForLoadState("networkidle"), page.click("[type=submit]")]);
  await page.screenshot({ path: path.join(UI, "admin_sign_in_failed.png"), fullPage: true });
  fs.writeFileSync(path.join(UI, "admin_sign_in_failed.html"), await page.content());
  await page.goto(BASE + "/admin/sign_in", { waitUntil: "networkidle" });
  await page.fill("input[name='user[email]']", fx.users.main.email);
  await page.fill("input[name='user[password]']", fx.users.main.password);
  await Promise.all([page.waitForURL(u => !u.pathname.includes("sign_in"), { timeout: 30000 }), page.click("[type=submit]")]);
  await page.waitForLoadState("networkidle");
  log.push(`UI login landed on ${page.url()}`);
  const pages = [
    ["admin_analytics_dashboard", "/admin/analytics"],
    ["admin_analytics_dashboard_range", `/admin/analytics?from=${FROM}&to=${TO}`],
    ["admin_analytics_category", `/admin/analytics/categories/${M.category_slug}?from=${FROM}&to=${TO}`],
    ["admin_analytics_merchant", `/admin/analytics/merchants/${M.merchant_slug}?from=${FROM}&to=${TO}`],
    ["admin_styleguide", "/admin/styleguide"],
    ["admin_versions_index", "/admin/versions"],
    ["admin_versions_show", `/admin/versions/${M.version_id}`],
    ["admin_bank_transactions_index", "/admin/bank_transactions"],
    ["admin_bank_transactions_show", `/admin/bank_transactions/${M.bank_transaction_id}`],
    ["admin_cash_transactions_index", "/admin/cash_transactions"],
    ["admin_cash_transactions_new", "/admin/cash_transactions/new"],
    ["admin_cash_transactions_show", `/admin/cash_transactions/${M.cash_transaction_id}`],
    ["admin_cash_transactions_edit", `/admin/cash_transactions/${M.cash_transaction_id}/edit`],
    ["admin_categories_index", "/admin/categories"],
    ["admin_categories_new", "/admin/categories/new?parent_path=food"],
    ["admin_categories_edit", `/admin/categories/${M.category_id}/edit`],
    ["admin_merchants_index", "/admin/merchants"],
    ["admin_merchants_new", "/admin/merchants/new"],
    ["admin_merchants_show", `/admin/merchants/${M.merchant_id}`],
    ["admin_merchants_edit", `/admin/merchants/${M.merchant_id}/edit`],
    ["admin_llm_enrichments_index", "/admin/llm_enrichments"],
    ["admin_llm_enrichments_show", `/admin/llm_enrichments/${llmId || 1}`],
    ["admin_matching_engine", "/admin/matching_engine"],
    ["admin_transaction_syncs_index", "/admin/transaction_syncs"],
    ["admin_transaction_syncs_new", "/admin/transaction_syncs/new"],
    ["admin_transaction_syncs_show", `/admin/transaction_syncs/${M.operation_run_sync_id}`],
    ["admin_tpp_credentials_index", "/admin/tpp_credentials"],
    ["admin_tpp_credentials_new", "/admin/tpp_credentials/new"],
    ["admin_tpp_credentials_show", `/admin/tpp_credentials/${M.tpp_credential_id}`],
    ["admin_tpp_credentials_edit", `/admin/tpp_credentials/${M.tpp_credential_id}/edit`],
    ["admin_bank_connections_index", "/admin/bank_connections"],
    ["admin_bank_connections_new", "/admin/bank_connections/new"],
    ["admin_bank_connections_show", `/admin/bank_connections/${M.bank_connection_id}`],
    ["admin_bank_connections_edit", `/admin/bank_connections/${M.bank_connection_id}/edit`],
    ["admin_sync_schedules_edit", `/admin/bank_connections/${M.bank_connection_id}/sync_schedule/edit`],
    ["admin_bank_accounts_index", "/admin/bank_accounts"],
    ["admin_bank_accounts_show", `/admin/bank_accounts/${M.bank_account_id}`],
    ["admin_settings_profile", "/admin/settings/preferences/profile"],
    ["admin_settings_app", "/admin/settings/preferences/app"],
    ["admin_settings_llm", "/admin/settings/preferences/llm"],
    ["admin_settings_data_exchange", "/admin/settings/preferences/data_exchange"],
    ["admin_settings_api_tokens", "/admin/settings/preferences/api_tokens"],
    ["admin_debug", "/admin/debug"],
    ["admin_debug_runtime_error", "/admin/debug/runtime_error"],
    ["sidekiq_dashboard", "/sidekiq"],
    ["api_docs_swagger_ui", "/api/v1/docs"],
    ["error_404_unknown_record", "/admin/merchants/99999999"],
  ];
  for (const [n, u] of pages) await shoot(page, n, u);
  // interactive states
  await shoot(page, "admin_cash_transactions_new_invalid_submit", "/admin/cash_transactions/new", { actions: async (p) => {
    const amt = await p.$("input[name='cash_transaction[amount]']"); if (amt) await amt.fill("abc");
    const btn = await p.$("form[action='/admin/cash_transactions'] [type=submit]"); if (btn) await Promise.all([p.waitForLoadState("networkidle"), btn.click()]); } });
  await shoot(page, "admin_command_palette_open", "/admin/analytics", { actions: async (p) => { await p.keyboard.press("Control+k"); await p.waitForTimeout(500); } });
  await shoot(page, "admin_privacy_mask_toggled", "/admin/bank_transactions", { actions: async (p) => {
    const t = await p.$("[data-action*='sensitive-mask']"); if (t) { await t.click(); await p.waitForTimeout(400); } } });
  // mobile viewport sample
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: UA, storageState: await ctx.storageState() });
  const mp = await m.newPage();
  await shoot(mp, "mobile_admin_analytics_dashboard", "/admin/analytics");
  await shoot(mp, "mobile_admin_bank_transactions_index", "/admin/bank_transactions");
  fs.writeFileSync(path.join(OUT, "ui_console_errors.txt"), consoleErrors.join("\n") + "\n");
  await browser.close();
}

async function phaseSetup() {
  const anon = await request.newContext({ baseURL: BASE });
  await rec(anon, { verb: "GET", route: "/admin/analytics(.:format)", path: "/admin/analytics", actor: "anon", caseName: "no_users_redirects_to_setup" });
  await rec(anon, { verb: "GET", route: "/setup(.:format)", path: "/setup", actor: "anon", caseName: "no_users" });
  let t = await csrfFrom(anon, "/setup");
  await rec(anon, { verb: "POST", route: "/setup(.:format)", path: "/setup", actor: "anon", caseName: "no_users_invalid", form: { authenticity_token: t, "user[name]": "", "user[email]": "bad", "user[password]": "short", "user[password_confirmation]": "mismatch" } });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA })).newPage();
  await shoot(page, "setup_first_run", "/setup");
  await shoot(page, "setup_first_run_invalid", "/setup", { actions: async (p) => {
    await p.fill("input[name='user[email]']", "bad"); await p.fill("input[name='user[password]']", "short");
    await Promise.all([p.waitForLoadState("networkidle"), p.click("form[action='/setup'] [type=submit]")]); } });
  t = await csrfFrom(anon, "/setup");
  await rec(anon, { verb: "POST", route: "/setup(.:format)", path: "/setup", actor: "anon", caseName: "no_users_valid", form: { authenticity_token: t, "user[name]": "First Admin", "user[email]": "first@example.com", "user[password]": "Password123!", "user[password_confirmation]": "Password123!" } });
  await shoot(page, "first_run_after_setup_dashboard", "/admin/sign_in");
  await browser.close();
  // merge with existing files from phase main
  for (const [f, v] of store) {
    const p = path.join(HTTP, f);
    if (fs.existsSync(p)) { const old = JSON.parse(fs.readFileSync(p, "utf8")); old.cases.push(...v.cases); fs.writeFileSync(p, JSON.stringify(old, null, 2)); }
    else fs.writeFileSync(p, JSON.stringify(v, null, 2));
  }
  fs.writeFileSync(path.join(OUT, `capture_log_${PHASE}.txt`), log.join("\n") + "\n");
}

(PHASE === "setup" ? phaseSetup() : phaseMain()).then(() => { console.log(`captured ${log.length} entries (${PHASE})`); }).catch(e => { flush(); console.error(e); process.exit(1); });
