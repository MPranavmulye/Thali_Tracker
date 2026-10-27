/*
 * Thali phone shim — runs the Thali app with no server of your own.
 *   db / assets  -> IndexedDB on this phone (works offline), synced to YOUR
 *                   Supabase project when signed in, so every phone matches
 *   sample (AI)  -> Gemini, Groq, OpenRouter called directly with your free keys
 *   downloads    -> normal browser download
 * The app file itself is the same as the Claude artifact.
 */
(function () {
  "use strict";

  /* ================= IndexedDB ================= */
  const STORES = ["docs", "assets", "settings", "outbox", "meta"];
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("thali", 2);
      r.onupgradeneeded = () => { const d = r.result; STORES.forEach(s => d.objectStoreNames.contains(s) || d.createObjectStore(s)); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const d = await openDB();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out; const rq = fn(Array.isArray(stores) ? stores.map(s => t.objectStore(s)) : t.objectStore(stores));
      if (rq && "onsuccess" in rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const SEP = "\u0001";
  const K = (col, id) => col + SEP + id;
  const range = col => IDBKeyRange.bound(col + SEP, col + "\u0002", false, true);
  const idbErr = e => ({ code: "unavailable", message: "Couldn't save on this phone: " + (e && e.message || e) });
  const meta = { get: k => tx("meta", "readonly", s => s.get(k)), set: (k, v) => tx("meta", "readwrite", s => s.put(v, k)) };

  /* ================= db capability (local first) ================= */
  const listeners = new Set();
  function snapshot(rows) {
    const docs = rows.map(r => ({ id: r.id, exists: true, data: () => r.data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })) };
  }
  const load = col => tx("docs", "readonly", s => s.getAll(range(col))).then(v => v || []);
  async function refresh(l) { try { l.next(snapshot(await load(l.col))); } catch (e) { l.err && l.err(idbErr(e)); } }
  const notify = col => listeners.forEach(l => { if (!col || l.col === col) refresh(l); });

  async function localWrite(col, id, data) {
    // data === null means delete. Writes the doc and queues it for the cloud in one transaction.
    const key = K(col, id);
    await tx(["docs", "outbox"], "readwrite", ([docs, out]) => {
      if (data === null) docs.delete(key); else docs.put({ id, data }, key);
      out.put({ col, id, data, ts: Date.now() }, key);
    });
    notify(col); scheduleFlush();
  }
  function docRef(col, id) {
    const key = K(col, id);
    return {
      id, path: col + "/" + id,
      async get() { const v = await tx("docs", "readonly", s => s.get(key)); return { id, exists: !!v, data: () => v && v.data, metadata: { fromCache: false, hasPendingWrites: false } }; },
      async set(data) { try { await localWrite(col, id, JSON.parse(JSON.stringify(data))); } catch (e) { throw idbErr(e); } },
      async update(data) { const cur = await tx("docs", "readonly", s => s.get(key)); if (!cur) throw { code: "not_found", message: "Not found" }; await this.set({ ...cur.data, ...data }); },
      async delete() { await localWrite(col, id, null); },
      onSnapshot(next, err) {
        const l = { col, next: snap => { const d = snap.docs.find(x => x.id === id); next(d || { id, exists: false, data: () => undefined, metadata: {} }); }, err };
        listeners.add(l); refresh(l); return () => listeners.delete(l);
      },
      collection: sub => collection(col + "/" + id + "/" + sub),
    };
  }
  function collection(col) {
    const q = {
      path: col,
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { return snapshot(await load(col)); },
      onSnapshot(next, err) { const l = { col, next, err }; listeners.add(l); refresh(l); return () => listeners.delete(l); },
      doc(id) { return docRef(col, id || ("a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))); },
      async add(data) { const r = q.doc(); await r.set(data); return r; },
    };
    return q;
  }
  const db = { collection, doc(p) { const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); } };

  /* ================= settings (AI keys + cloud config) ================= */
  const DEFAULTS = {
    order: "gemini,groq,openrouter",
    gemini_key: "", groq_key: "", openrouter_key: "",
    gemini_model: "gemini-3.8-flash", gemini_quick: "gemini-3.5-flash-lite",
    groq_model: "qwen/qwen3.8-27b", openrouter_model: "openrouter/free",
  };
  const AI_FIELDS = Object.keys(DEFAULTS);
  let settings = { ...DEFAULTS };
  let cloudCfg = { url: "", key: "" };
  const settingsReady = Promise.all([
    tx("settings", "readonly", s => s.get("ai")).then(v => { settings = { ...DEFAULTS, ...(v || {}) }; }),
    tx("settings", "readonly", s => s.get("cloud")).then(v => { if (v) cloudCfg = v; }),
  ]).catch(() => {});
  async function saveSettings(v, fromCloud) {
    settings = { ...DEFAULTS, ...v };
    await tx("settings", "readwrite", s => s.put(settings, "ai"));
    if (!fromCloud) { const ai = {}; AI_FIELDS.forEach(k => ai[k] = settings[k]); await tx("outbox", "readwrite", s => s.put({ col: "settings", id: "ai", data: ai, ts: Date.now() }, K("settings", "ai"))); scheduleFlush(); }
  }
  const keyFor = p => settings[p + "_key"];

  /* ================= cloud sync (Supabase) ================= */
  const cloud = { client: null, user: null, channel: null, status: "off", lastSync: null, error: "", pending: 0 };
  const cfg = () => {
    const c = window.THALI_CONFIG || {};
    return { url: (c.supabaseUrl || cloudCfg.url || "").trim().replace(/\/+$/, ""), key: (c.supabaseKey || cloudCfg.key || "").trim(), baked: !!(c.supabaseUrl && c.supabaseKey) };
  };
  const statusListeners = new Set();
  const setStatus = (s, err) => { cloud.status = s; if (err !== undefined) cloud.error = err; statusListeners.forEach(f => { try { f(); } catch (_) {} }); };

  async function initCloud() {
    const c = cfg();
    if (!c.url || !c.key || !window.supabase) { setStatus("off"); return; }
    try {
      cloud.client = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "thali-auth" } });
    } catch (e) { setStatus("error", "Sync settings look wrong: " + e.message); return; }
    cloud.client.auth.onAuthStateChange((_ev, session) => { setTimeout(() => setUser(session ? session.user : null), 0); });
    const { data } = await cloud.client.auth.getSession();
    await setUser(data && data.session ? data.session.user : null);
  }
  async function setUser(u) {
    if ((u && u.id) === (cloud.user && cloud.user.id)) return;
    cloud.user = u || null;
    if (cloud.channel) { try { cloud.client.removeChannel(cloud.channel); } catch (_) {} cloud.channel = null; }
    if (!u) { setStatus("signed_out", ""); return; }
    setStatus("syncing", "");
    await firstUpload();
    await sync();
    subscribe();
  }
  const rowKeyOK = r => r && typeof r.col === "string" && typeof r.id === "string";

  async function firstUpload() {
    // The first time this phone signs in, add its existing log to the cloud.
    // Records already in the cloud win (nothing there is overwritten).
    const flag = "uploaded:" + cloud.user.id;
    if (await meta.get(flag)) return;
    const rows = (await tx("docs", "readonly", s => s.getAll()) || []);
    const keys = await tx("docs", "readonly", s => s.getAllKeys()) || [];
    const payload = rows.map((r, i) => { const k = String(keys[i]); const col = k.slice(0, k.indexOf(SEP)); return { user_id: cloud.user.id, col, id: r.id, data: r.data, deleted: false }; });
    try {
      for (let i = 0; i < payload.length; i += 200) {
        const { error } = await cloud.client.from("docs").upsert(payload.slice(i, i + 200), { onConflict: "user_id,col,id", ignoreDuplicates: true });
        if (error) throw error;
      }
      if (["gemini", "groq", "openrouter"].some(keyFor)) {
        const ai = {}; AI_FIELDS.forEach(k => ai[k] = settings[k]);
        const { error } = await cloud.client.from("docs").upsert([{ user_id: cloud.user.id, col: "settings", id: "ai", data: ai, deleted: false }], { onConflict: "user_id,col,id", ignoreDuplicates: true });
        if (error) throw error;
      }
      // Local edits made before sign-in are already covered; clear their queue entries.
      await tx("outbox", "readwrite", s => s.clear());
      await meta.set(flag, Date.now());
    } catch (e) { setStatus("error", "Couldn't upload this phone's log: " + (e.message || e)); }
  }

  let flushTimer = null, flushing = false;
  function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400); }
  async function countPending() { cloud.pending = await tx("outbox", "readonly", s => s.count()) || 0; return cloud.pending; }
  async function flush() {
    if (!cloud.user || flushing) { await countPending(); setStatus(cloud.status); return; }
    if (!navigator.onLine) { await countPending(); setStatus("offline"); return; }
    flushing = true;
    try {
      const ops = await tx("outbox", "readonly", s => s.getAll()) || [];
      for (let i = 0; i < ops.length; i += 200) {
        const batch = ops.slice(i, i + 200);
        const rows = batch.map(o => ({ user_id: cloud.user.id, col: o.col, id: o.id, data: o.data, deleted: o.data === null }));
        const { error } = await cloud.client.from("docs").upsert(rows, { onConflict: "user_id,col,id" });
        if (error) throw error;
        // Remove only the queue entries that haven't changed since we read them.
        await tx("outbox", "readwrite", s => { batch.forEach(o => { const k = K(o.col, o.id); const g = s.get(k); g.onsuccess = () => { if (g.result && g.result.ts === o.ts) s.delete(k); }; }); });
      }
      await countPending();
      setStatus("synced", "");
    } catch (e) { await countPending(); setStatus("error", "Upload failed: " + (e.message || e) + ". Will retry."); }
    finally { flushing = false; }
  }

  async function applyRows(rows) {
    if (!rows.length) return;
    const pending = new Set((await tx("outbox", "readonly", s => s.getAllKeys()) || []).map(String));
    let gotSettings = null;
    await tx("docs", "readwrite", s => {
      rows.forEach(r => {
        if (!rowKeyOK(r)) return;
        const k = K(r.col, r.id);
        if (pending.has(k)) return; // this phone has a newer, not-yet-uploaded change
        if (r.col === "settings") { if (r.id === "ai" && r.data && !r.deleted) gotSettings = r.data; return; }
        if (r.deleted || r.data == null) s.delete(k); else s.put({ id: r.id, data: r.data }, k);
      });
    });
    if (gotSettings) await saveSettings({ ...settings, ...gotSettings }, true);
    notify();
  }
  let syncing = false;
  async function sync() {
    if (!cloud.user || syncing) return;
    if (!navigator.onLine) { setStatus("offline"); return; }
    syncing = true; setStatus("syncing");
    try {
      await flush();
      const since = (await meta.get("lastSync:" + cloud.user.id)) || "1970-01-01T00:00:00Z";
      // small overlap so rows committed at the same moment aren't missed (applying twice is harmless)
      const from = new Date(new Date(since).getTime() - 5000).toISOString();
      let maxTs = since, page = 0;
      for (;;) {
        const { data, error } = await cloud.client.from("docs").select("col,id,data,deleted,updated_at")
          .gt("updated_at", from).order("updated_at", { ascending: true }).range(page * 1000, page * 1000 + 999);
        if (error) throw error;
        await applyRows(data || []);
        (data || []).forEach(r => { if (r.updated_at > maxTs) maxTs = r.updated_at; });
        if (!data || data.length < 1000) break;
        page++;
      }
      await meta.set("lastSync:" + cloud.user.id, maxTs);
      cloud.lastSync = new Date();
      await countPending();
      setStatus("synced", "");
    } catch (e) { setStatus("error", "Sync failed: " + (e.message || e) + ". Will retry."); }
    finally { syncing = false; }
  }
  function subscribe() {
    if (!cloud.client || !cloud.user) return;
    try {
      cloud.channel = cloud.client.channel("thali-" + cloud.user.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "user_id=eq." + cloud.user.id },
          p => { const r = p.new && Object.keys(p.new).length ? p.new : null; if (r) applyRows([r]).then(() => { cloud.lastSync = new Date(); setStatus("synced"); }); })
        .subscribe();
    } catch (_) { /* live updates are a bonus; periodic sync still runs */ }
  }
  window.addEventListener("online", () => sync());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) sync(); }, 45000);

  /* ================= assets (photos) ================= */
  const assets = {
    async upload(blob) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { await tx("assets", "readwrite", s => s.put({ blob, type: blob.type || "image/jpeg" }, id)); } catch (e) { throw idbErr(e); }
      let url = "assets/" + id;
      if (cloud.user && navigator.onLine) {
        try {
          const path = cloud.user.id + "/" + id + ".jpg";
          const up = await cloud.client.storage.from("photos").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });
          if (up.error) throw up.error;
          const sg = await cloud.client.storage.from("photos").createSignedUrl(path, 60 * 60 * 24 * 365 * 5);
          if (sg.error) throw sg.error;
          url = sg.data.signedUrl; // viewable from both phones
        } catch (_) { /* keep the local copy; the thumbnail still syncs */ }
      }
      return { id, url, sizeBytes: blob.size, contentType: blob.type };
    },
    list: async () => ({ assets: [], usage: {} }),
    delete: id => tx("assets", "readwrite", s => s.delete(id)),
  };

  /* ================= AI providers ================= */
  const MAXTOK = 8192;
  class PErr extends Error { constructor(m, code) { super(m); this.code = code || "unavailable"; } }
  async function post(url, headers, body, name) {
    let r;
    const ctl = new AbortController(); const tmo = setTimeout(() => ctl.abort(), 120000);
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal }); }
    catch (e) { throw new PErr(`${name}: couldn't connect${e.name === "AbortError" ? " (timed out)" : ""}`); }
    finally { clearTimeout(tmo); }
    if (r.ok) return r.json();
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    if (r.status === 429) throw new PErr(`${name}: free limit reached for now`, "rate_limited");
    if (r.status === 401 || r.status === 403) throw new PErr(`${name}: key not accepted — check it in AI keys`);
    if (r.status === 404) throw new PErr(`${name}: model not found — update the model name in AI keys`);
    throw new PErr(`${name}: error ${r.status} ${txt}`);
  }
  async function gemini(msgs, images, tier, json) {
    const model = tier === "quick" ? settings.gemini_quick : settings.gemini_model;
    const contents = msgs.map((m, i) => ({ role: m.role === "assistant" ? "model" : "user",
      parts: (i === msgs.length - 1 ? images.map(im => ({ inline_data: { mime_type: im.media_type, data: im.data } })) : []).concat([{ text: m.content }]) }));
    const gc = { maxOutputTokens: MAXTOK, temperature: 0.2 }; if (json) gc.responseMimeType = "application/json";
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": keyFor("gemini") }, { contents, generationConfig: gc }, "Gemini");
    const c = (j.candidates || [{}])[0];
    const text = ((c.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (!text) throw new PErr(`Gemini returned no answer (${c.finishReason || "unknown"})`);
    return { text, truncated: c.finishReason === "MAX_TOKENS", model };
  }
  async function chat(url, key, name, model, msgs, images, json, jsonMode, extra) {
    const messages = msgs.map((m, i) => (m.role === "user" && i === msgs.length - 1 && images.length)
      ? { role: "user", content: [{ type: "text", text: m.content }].concat(images.map(im => ({ type: "image_url", image_url: { url: `data:${im.media_type};base64,${im.data}` } }))) }
      : { role: m.role, content: m.content });
    const body = { model, messages, max_tokens: MAXTOK, temperature: 0.2 };
    if (json && jsonMode) body.response_format = { type: "json_object" };
    const j = await post(url, { Authorization: "Bearer " + key, ...(extra || {}) }, body, name);
    const ch = (j.choices || [{}])[0]; let text = (ch.message || {}).content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
    if (!text) throw new PErr(`${name} returned no answer`);
    return { text, truncated: ch.finish_reason === "length", model };
  }
  const PROVIDERS = {
    gemini,
    groq: (m, im, t, j) => chat("https://api.groq.com/openai/v1/chat/completions", keyFor("groq"), "Groq", settings.groq_model, m, im, j, true),
    openrouter: (m, im, t, j) => chat("https://openrouter.ai/api/v1/chat/completions", keyFor("openrouter"), "OpenRouter", settings.openrouter_model, m, im, j, false,
      { "X-Title": "Thali Calorie Tracker", "HTTP-Referer": location.origin }),
  };
  const chain = () => settings.order.split(",").map(s => s.trim().toLowerCase()).filter(p => PROVIDERS[p] && keyFor(p));
  function blobToB64(b) { return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(",")[1]); f.onerror = rej; f.readAsDataURL(b); }); }
  let lastUsed = null;
  async function ask(input, opts, json) {
    await settingsReady;
    opts = opts || {};
    const list = chain();
    if (!list.length) { setTimeout(openSettings, 50); throw { code: "not_configured", message: "Add a free AI key first: ☰ menu → AI keys." }; }
    const msgs = typeof input === "string" ? [{ role: "user", content: input }] : input.map(m => ({ role: m.role, content: String(m.content) }));
    const images = [];
    for (const b of opts.images || []) images.push({ media_type: b.type || "image/jpeg", data: await blobToB64(b) });
    const errs = [];
    for (const p of list) {
      try {
        const r = await PROVIDERS[p](msgs, images, opts.modelTier || "default", json);
        if (json && r.truncated) throw new PErr(`${p}: answer was cut short`);
        lastUsed = { provider: p, model: r.model, at: new Date().toLocaleString(), failed: errs.slice() };
        if (opts.onText) try { opts.onText({ text: r.text, delta: r.text }); } catch (_) {}
        return r;
      } catch (e) { errs.push(e.message || String(e)); }
    }
    throw { code: errs.every(e => /limit/.test(e)) ? "rate_limited" : "unavailable", message: "All AI providers failed. " + errs.join(" · ") };
  }
  function parseTolerant(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (_) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (_) {} }
    const a = t.search(/[\[{]/), z = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (_) {} }
    throw { code: "invalid_json", message: "The AI answer wasn't in the expected format.", text: t };
  }
  async function sample(input, opts) { const r = await ask(input, opts, false); return { text: r.text, truncated: r.truncated }; }
  sample.json = async (input, opts) => parseTolerant((await ask(input, opts, true)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 3, maxInputBytes: 15 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });

  /* ================= user / downloads ================= */
  const user = { id: async () => "local", me: async () => ({ id: "local", name: "You" }), isOwner: () => true, canEdit: () => true, can: () => true,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, { id: i, name: "You" }])), search: async () => [] };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = u; a.download = filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
      return { status: "saved" };
    },
  };

  /* ================= screens ================= */
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === "text") e.textContent = v; else if (k === "value") e.value = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); }
    kids.flat().forEach(c => c != null && c !== false && e.append(c)); return e;
  }
  function sheetShell(id, title, body, actions) {
    document.getElementById(id)?.remove();
    const close = () => document.getElementById(id)?.remove();
    const sc = el("div", { class: "scrim", id, style: "z-index:35", onclick: e => { if (e.target === sc) close(); } },
      el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
        el("div", { class: "sheet-h" }, el("h2", { class: "h3", text: title }), el("button", { class: "btn", type: "button", text: "Close", onclick: close })),
        body, actions ? el("div", { class: "btns" }, actions) : null));
    document.body.appendChild(sc);
    return close;
  }
  function toastMsg(m) { const t = el("div", { class: "toast", role: "status", text: m }); document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }

  async function openSettings() {
    await settingsReady;
    if (document.getElementById("thali-keys")) return;
    const inputs = {};
    const keyRow = (p, label, url, hint) => {
      const inp = el("input", { class: "inp", id: "k-" + p, type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Paste key", value: settings[p + "_key"] || "" });
      inputs[p + "_key"] = inp;
      const show = el("button", { class: "btn", type: "button", text: "Show", onclick: () => { inp.type = inp.type === "password" ? "text" : "password"; show.textContent = inp.type === "password" ? "Show" : "Hide"; } });
      return el("div", { class: "stack", style: "gap:6px" },
        el("label", { class: "field", for: "k-" + p, text: label }), el("div", { style: "display:flex;gap:6px" }, inp, show),
        el("div", { class: "small muted", text: (hint ? hint + " " : "") + "Get one at " + url }), el("div", { class: "small muted", id: "st-" + p }));
    };
    const adv = {};
    const advRow = (k, label) => { const i = el("input", { class: "inp", id: "a-" + k, value: settings[k] }); adv[k] = i; return el("label", { class: "field", for: "a-" + k, text: label }, i); };
    const collect = () => { const v = { ...settings }; Object.entries(inputs).forEach(([k, i]) => v[k] = i.value.trim()); Object.entries(adv).forEach(([k, i]) => v[k] = i.value.trim() || DEFAULTS[k]); return v; };
    const testBtn = el("button", { class: "btn soft", type: "button", text: "Test keys" });
    testBtn.onclick = async () => {
      const v = collect(), prev = settings; settings = v; testBtn.disabled = true;
      for (const p of ["gemini", "groq", "openrouter"]) {
        const st = document.getElementById("st-" + p);
        if (!v[p + "_key"]) { st.textContent = "No key"; st.style.color = ""; continue; }
        st.textContent = "Testing…"; st.style.color = "";
        try { await PROVIDERS[p]([{ role: "user", content: 'Reply with only {"ok":true}' }], [], "quick", true); st.textContent = "✓ Working"; st.style.color = "var(--green)"; }
        catch (e) { st.textContent = "✗ " + e.message; st.style.color = "var(--pink)"; }
      }
      settings = prev; testBtn.disabled = false;
    };
    const saveBtn = el("button", { class: "btn pri", type: "button", text: "Save" });
    const used = lastUsed ? `Last answer came from ${lastUsed.provider} (${lastUsed.model}) at ${lastUsed.at}.` : "";
    const close = sheetShell("thali-keys", "AI keys", el("div", { class: "stack" },
      el("p", { class: "muted small", style: "margin:0", text: "Free keys, no card needed. You need at least one; with more, the app switches automatically when a free limit runs out." + (cloud.user ? " Keys sync to your other phone through your account." : " Keys are stored on this phone.") }),
      keyRow("gemini", "1. Google Gemini (main)", "aistudio.google.com/apikey", "Best for food photos."),
      keyRow("groq", "2. Groq (backup)", "console.groq.com/keys", ""),
      keyRow("openrouter", "3. OpenRouter (backup)", "openrouter.ai/settings/keys", ""),
      el("details", {}, el("summary", { class: "small", text: "Advanced: order and model names" }),
        el("div", { class: "stack", style: "margin-top:10px" }, advRow("order", "Order (comma separated)"), advRow("gemini_model", "Gemini model"), advRow("gemini_quick", "Gemini quick model"),
          advRow("groq_model", "Groq model"), advRow("openrouter_model", "OpenRouter model"))),
      el("p", { class: "small muted", style: "margin:0", text: "Free tiers may use what you send to improve their models. " + used })), [testBtn, saveBtn]);
    saveBtn.onclick = async () => { await saveSettings(collect()); close(); toastMsg(chain().length ? "AI keys saved" : "Saved — add at least one key to use AI"); };
  }

  function statusText() {
    const c = cfg();
    if (!c.url || !c.key) return "Sync is not set up. Your log is stored on this phone only.";
    if (!cloud.user) return "Not signed in. Your log is stored on this phone only.";
    const when = cloud.lastSync ? cloud.lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const pend = cloud.pending ? ` · ${cloud.pending} change${cloud.pending > 1 ? "s" : ""} waiting to upload` : "";
    return { syncing: "Syncing…", synced: `Synced at ${when}${pend}`, offline: `Offline — changes are saved on this phone and will upload later${pend}`, error: cloud.error || "Sync problem", signed_out: "Not signed in" }[cloud.status] || `Signed in${pend}`;
  }
  async function openAccount() {
    await settingsReady;
    const c = cfg();
    const msg = el("div", { class: "small", role: "status" });
    const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--pink)" : ""; };
    // step 1: connection details (only when not baked into config.js)
    if (!c.url || !c.key || (cloud.status === "error" && !cloud.client)) {
      const u = el("input", { class: "inp", id: "sb-url", placeholder: "https://xxxx.supabase.co", value: c.url, autocomplete: "off" });
      const k = el("input", { class: "inp", id: "sb-key", placeholder: "sb_publishable_…", value: c.key, autocomplete: "off" });
      const save = el("button", { class: "btn pri", type: "button", text: "Connect" });
      const close = sheetShell("thali-acct", "Sync between phones", el("div", { class: "stack" },
        el("p", { class: "small muted", style: "margin:0", text: "Paste the two values from your Supabase project (Project Settings → API). You only do this once per phone — or put them in config.js so every phone has them already." }),
        el("label", { class: "field", for: "sb-url", text: "Project URL" }, u), el("label", { class: "field", for: "sb-key", text: "Publishable key" }, k), msg), [save]);
      save.onclick = async () => {
        if (!/^https:\/\/.+/.test(u.value.trim()) || !k.value.trim()) { say("Enter both values.", true); return; }
        cloudCfg = { url: u.value.trim(), key: k.value.trim() };
        await tx("settings", "readwrite", s => s.put(cloudCfg, "cloud"));
        close(); await initCloud(); openAccount();
      };
      return;
    }
    if (!cloud.client) await initCloud();
    if (cloud.user) {
      const status = el("div", { class: "small", text: statusText() });
      const refresh = () => { status.textContent = statusText(); };
      statusListeners.add(refresh);
      const syncBtn = el("button", { class: "btn soft", type: "button", text: "Sync now", onclick: async () => { await sync(); refresh(); } });
      const outBtn = el("button", { class: "btn", type: "button", text: "Sign out" });
      const close = sheetShell("thali-acct", "Sync between phones", el("div", { class: "stack" },
        el("p", { style: "margin:0", text: "Signed in as " + (cloud.user.email || "you") + "." }), status,
        el("p", { class: "small muted", style: "margin:0", text: "Sign in with the same email on your other phone and both stay in step. Entries you make offline upload automatically when you're back online." })), [outBtn, syncBtn]);
      outBtn.onclick = async () => { await cloud.client.auth.signOut(); statusListeners.delete(refresh); close(); toastMsg("Signed out. Your log stays on this phone."); };
      return;
    }
    const email = el("input", { class: "inp", id: "sb-email", type: "email", autocomplete: "email", placeholder: "you@example.com" });
    const pw = el("input", { class: "inp", id: "sb-pw", type: "password", autocomplete: "current-password", placeholder: "At least 8 characters" });
    const inBtn = el("button", { class: "btn pri", type: "button", text: "Sign in" });
    const upBtn = el("button", { class: "btn", type: "button", text: "Create account" });
    const close = sheetShell("thali-acct", "Sync between phones", el("div", { class: "stack" },
      el("p", { class: "small muted", style: "margin:0", text: "Sign in with the same account on both phones and your log, photos and AI keys stay in sync. First time? Tap Create account." }),
      el("label", { class: "field", for: "sb-email", text: "Email" }, email), el("label", { class: "field", for: "sb-pw", text: "Password" }, pw), msg), [upBtn, inBtn]);
    const go = async (mode) => {
      const e = email.value.trim(), p = pw.value;
      if (!/.+@.+\..+/.test(e)) { say("Enter your email address.", true); return; }
      if (p.length < 8) { say("Use a password of at least 8 characters.", true); return; }
      inBtn.disabled = upBtn.disabled = true; say(mode === "in" ? "Signing in…" : "Creating your account…");
      try {
        if (mode === "in") {
          const { error } = await cloud.client.auth.signInWithPassword({ email: e, password: p });
          if (error) throw error;
        } else {
          const { data, error } = await cloud.client.auth.signUp({ email: e, password: p, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) { say("Check your email and tap the confirmation link, then come back and sign in."); inBtn.disabled = upBtn.disabled = false; return; }
        }
        const { data } = await cloud.client.auth.getSession();
        await setUser(data.session && data.session.user);
        close(); toastMsg("Signed in — syncing your log");
        if (!chain().length) setTimeout(openSettings, 600);
      } catch (err) {
        const m = String(err.message || err);
        say(/invalid login/i.test(m) ? "Wrong email or password." : /not confirmed/i.test(m) ? "Confirm your email first (check your inbox), then sign in." : /already registered/i.test(m) ? "This email already has an account. Tap Sign in." : m, true);
        inBtn.disabled = upBtn.disabled = false;
      }
    };
    inBtn.onclick = () => go("in"); upBtn.onclick = () => go("up");
  }

  /* ================= boot ================= */
  let markReady; const ready = new Promise(r => { markReady = r; });
  window.thaliHost = {
    ready,
    openSettings,
    menu: [
      { label: "Sync between phones", icon: "copy", action: openAccount },
      { label: "AI keys", icon: "spark", action: openSettings },
    ],
    get storageNote() { return statusText(); },
  };
  const caps = { db, sample, user, assets, downloads };
  window.claude = Object.freeze({ use: async name => caps[name] || null });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  settingsReady.then(async () => {
    await initCloud().catch(e => setStatus("error", String(e.message || e)));
    await countPending().catch(() => {});
    const c = cfg();
    if (c.url && c.key && !cloud.user) {
      // the app waits for sign-in (or for this screen to be dismissed) before asking for a profile
      setTimeout(() => openAccount().finally(() => {
        const t = setInterval(() => {
          const done = cloud.user ? cloud.status !== "syncing" : !document.getElementById("thali-acct");
          if (done) { clearInterval(t); markReady(); }
        }, 300);
      }), 600);
    } else {
      markReady();
      if (!chain().length) setTimeout(openSettings, 900);
    }
  });
})();
