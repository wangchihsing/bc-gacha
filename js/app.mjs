import * as E from "./engine.mjs";
import * as GH from "./github.mjs";

const FOOD_PER_ELEVEN = 1500;
const TOKEN_KEY = "bcg-token";
const ICON = { t: "img/ticket.png", f: "img/food.png" };
// 白金、傳說與一般池共用序列；各自用目前最新的那一池
const EXTRAS = [{ action: "plat", label: "白金" }, { action: "legend", label: "傳說" }];
const ACTION_LABEL = { ticket: "金券", eleven: "11 連", plat: "白金券", legend: "傳說券" };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
  set: v => { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
};

let D, token = "", sha = null, progress = null, busy = false;
const ui = { event: null, goals: [], prio: "draws", plan: null, manual: [], seqRows: 20, confirm: null, saved: "" };
let pool, table, base, extras = [];

const today = () => new Date().toLocaleDateString("sv-SE");
const elevenCap = () => Math.floor(progress.food / FOOD_PER_ELEVEN);
const glabel = cat => E.labelOf(base + E.cellIndex(cat));
const rarityCls = cat => cat.rarity === 4 ? "uber" : cat.rarity === 5 ? "legend" : "";
const isTarget = id => ui.goals.includes(id);
const icon = k => `<img class="icon" src="${ICON[k]}" alt="">`;
const catName = id => D.cats[id]?.name?.[0] ?? String(id);

function sync(text, bad = false) {
  $("sync").textContent = text;
  $("sync").classList.toggle("bad", bad);
}

function rebuild() {
  pool = E.makePool(D, ui.event);
  const count = Math.min(1200, Math.max(240, progress.tickets + 11 * elevenCap() + 100, ui.seqRows + 10));
  table = E.buildTable(pool, { seed: progress.seed, last: progress.last, count });
  base = E.indexOf(progress.position);
  extras = EXTRAS.map(x => {
    const key = extraEvent(x.action);
    if (!key) return null;
    const p = E.makePool(D, key);
    return { ...x, key, pool: p, rows: E.buildTable(p, { seed: progress.seed, last: progress.last, count }).rows };
  }).filter(Boolean);
}

function extraEvent(kind) {
  return Object.entries(D.events).filter(([, e]) => e.k === kind && e.s <= today() && e.e >= today())
    .sort((a, b) => b[1].s.localeCompare(a[1].s))[0]?.[0];
}

// 某隻角色在這個卡池、白金、傳說的哪幾個池抽得到
function poolsOf(id) {
  const has = p => (p.slots[4] || []).includes(id) || (p.slots[5] || []).includes(id);
  return [...(has(pool) ? ["一般"] : []), ...extras.filter(x => has(x.pool)).map(x => x.label)];
}
const extraCell = (x, cat) => { const i = E.cellIndex(cat); return x.rows[i >> 1]?.[i & 1]; };

// ---------- 存到 GitHub ----------
// 成功才換成新進度；別處先改過就載入最新的，不覆蓋
async function persist(next, message) {
  busy = true;
  sync("存檔中…");
  try {
    sha = await GH.save(token, next, sha, message);
    progress = next;
    sync("已存到 GitHub");
    return true;
  } catch (err) {
    if (err instanceof GH.ConflictError) {
      await reload();
      ui.saved = "進度在別的地方改過，已載入最新的；請重新確認再存。";
      renderAll();
    } else {
      sync("存檔失敗", true);
      ui.saved = `沒有存到：${err.message}`;
      renderPlan(); renderManual();
    }
    return false;
  } finally {
    busy = false;
  }
}

async function reload() {
  const r = await GH.load(token);
  progress = r.data; sha = r.sha;
  progress.plat ??= 0; progress.legend ??= 0;
  ui.event = D.events[progress.event] && !D.events[progress.event].k ? progress.event : currentEvents()[0]?.k;
  ui.plan = null; ui.manual = []; ui.confirm = null;
  rebuild();
  sync("已同步");
}

// ---------- 抽卡步驟 ----------
function draws(step) {
  return step.cats.map((cat, i) => {
    const isG = /G$/.test(cat.extraLabel || "");
    const atCat = isG ? step.cats[i - 1].next : cat;
    const at = glabel(atCat), after = cat.next ? glabel(cat.next) : "";
    return { cat, at, after, switched: after && at.slice(-1) !== after.slice(-1) };
  });
}

function stepFrom(cat, action) {
  if (!cat) return null;
  if (action === "ticket") return cat.next ? { action, cats: [cat], next: cat.next } : null;
  if (action === "eleven") return E.elevenFrom(cat, pool.guaranteedRolls);
  const x = extras.find(x => x.action === action);
  return x ? E.extraFrom(cat, x.rows, table.rows, action) : null;
}

function cost(steps) {
  const n = a => steps.filter(s => s.action === a).length;
  const t = n("ticket"), e = n("eleven");
  return { t, e, p: n("plat"), l: n("legend"), food: e * FOOD_PER_ELEVEN, draws: t + 11 * e };
}
const affordable = c => c.t <= progress.tickets && c.food <= progress.food && c.p <= progress.plat && c.l <= progress.legend;

function stagesOf(steps) {
  const stages = [];
  for (const s of steps) {
    const prev = stages.at(-1);
    if (s.action === prev?.action && s.action !== "eleven") prev.steps.push(s);
    else stages.push({ action: s.action, steps: [s] });
  }
  return stages;
}

// ---------- 頂部狀態與卡池 ----------
function currentEvents() {
  return Object.entries(D.events).map(([k, e]) => ({ k, e }))
    .filter(x => !x.e.k && x.e.e >= today()).sort((a, b) => a.e.s.localeCompare(b.e.s));
}

function renderStatus() {
  const start = table.start;
  $("pos").textContent = progress.position;
  $("next-name").textContent = start.name;
  $("next-name").style.color = start.rarity === 4 ? "var(--uber)" : start.rarity === 5 ? "var(--legend)" : "";
  const g = pool.guaranteedRolls === 11 && start.guaranteed;
  $("next-g").textContent = g ? `從這格開 11 連，保證拿到 ${start.guaranteed.name}` : "這個卡池的 11 連沒有保證超激";
  $("next-x").textContent = extras.map(x => `${x.label}這格：${extraCell(x, start)?.name ?? "—"}`).join("｜");
  $("tickets").value = progress.tickets;
  $("food").value = progress.food;
  $("plat").value = progress.plat;
  $("legend").value = progress.legend;
  const ev = D.events[ui.event];
  const pct = n => (n / 100).toFixed(n % 100 ? 1 : 0) + "%";
  const md = s => s.slice(5).replace("-", "/");
  const legend = 10000 - ev.rare - ev.supa - ev.uber;
  $("pool-meta").textContent = `${md(ev.s)}～${md(ev.e)}・超激 ${pct(ev.uber)}` +
    (legend > 0 ? `・傳說 ${pct(legend)}` : "") + (ev.guaranteed ? "・11 連保證超激" : "") +
    (ev.e < today() ? "・已結束" : "");
}

function renderPools() {
  const sel = $("pool");
  const past = Object.entries(D.events).map(([k, e]) => ({ k, e }))
    .filter(x => !x.e.k && x.e.e < today()).sort((a, b) => b.e.s.localeCompare(a.e.s));
  const opt = x => `<option value="${x.k}">${esc(x.e.s.slice(5).replace("-", "/"))} ${esc(x.e.n.replace(/★.*$/, ""))}</option>`;
  sel.innerHTML = `<optgroup label="進行中與即將登場">${currentEvents().map(opt).join("")}</optgroup>` +
    `<optgroup label="過往卡池">${past.map(opt).join("")}</optgroup>`;
  sel.value = ui.event;
}

// ---------- 目標角色 ----------
let catalog = [];
const norm = s => s.normalize("NFKC").toLowerCase();
const inPool = id => poolsOf(id).length > 0;

function renderSuggest(open) {
  const box = $("suggest"), q = norm($("q").value.trim());
  if (!open || ui.goals.length >= 3) { box.hidden = true; $("q").setAttribute("aria-expanded", "false"); return; }
  const hits = catalog.filter(c => !isTarget(c.id))
    .map(c => ({ c, r: !q ? 0 : c.names.some(n => norm(n).startsWith(q)) ? 0 : c.names.some(n => norm(n).includes(q)) ? 1 : 2 }))
    .filter(h => h.r < 2 && (q || inPool(h.c.id)))
    .sort((a, b) => a.r - b.r || a.c.names[0].localeCompare(b.c.names[0], "zh-Hant"));
  const group = (title, arr) => arr.length ? `<div class="grp">${title}（${arr.length}）</div>` +
    arr.slice(0, 40).map(h => `<button data-id="${h.c.id}">${esc(h.c.names[0])}${h.c.rarity === 5 ? "（傳說稀有）" : ""}` +
      `${inPool(h.c.id) ? `<span class="muted small">・${poolsOf(h.c.id).join("、")}</span>` : ""}</button>`).join("") : "";
  const yes = hits.filter(h => inPool(h.c.id)), no = hits.filter(h => !inPool(h.c.id));
  box.innerHTML = group("抽得到", yes) + group("現在抽不到", no) || `<div class="grp">找不到符合的角色</div>`;
  box.hidden = false;
  $("q").setAttribute("aria-expanded", "true");
}

function renderChips() {
  $("chips").innerHTML = ui.goals.map(id => `<span class="chip ${inPool(id) ? "" : "out"}"><span>${esc(catName(id))}・${inPool(id) ? poolsOf(id).join("、") : "現在抽不到"}</span>` +
    `<button data-rm="${id}" aria-label="移除 ${esc(catName(id))}">×</button></span>`).join("");
  $("q").placeholder = ui.goals.length >= 3 ? "最多 3 個，先移除一個" : "輸入角色名稱，最多 3 個";
}

// ---------- 找抽法 ----------
function drawRow(d) {
  return `<li class="draw ${rarityCls(d.cat)} ${isTarget(d.cat.id) ? "target" : ""}"><span class="mono">${d.at}</span>` +
    `<span class="nm">${esc(d.cat.name)}</span>${d.switched ? `<span class="sw">換到 ${d.after}</span>` : "<span></span>"}</li>`;
}

const XTAG = a => `<span class="xtag ${a}">${a === "plat" ? "白金" : "傳說"}</span>`;
function stageHead(st) {
  if (st.action === "ticket") return `${icon("t")}× ${st.steps.length}`;
  if (st.action === "eleven") return `${icon("f")}11 連`;
  return `${XTAG(st.action)}× ${st.steps.length}`;
}
function stageTitle(st) {
  if (st.action === "ticket") return icon("t") + `金券 × ${st.steps.length}`;
  if (st.action === "eleven") return icon("f") + "11 連抽";
  return XTAG(st.action) + `${ACTION_LABEL[st.action]} × ${st.steps.length}`;
}

function renderStages(steps) {
  const stages = stagesOf(steps);
  const head = stages.map((st, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="seg-item">` +
    stageHead(st) + "</span>").join("");
  const items = stages.map(st => {
    const ds = st.steps.flatMap(draws);
    const hits = ds.filter(d => isTarget(d.cat.id));
    const sw = ds.filter(d => d.switched && !/G$/.test(d.cat.extraLabel || ""));
    return `<li class="step"><div class="step-title">${stageTitle(st)}` +
      `<span class="mono muted">${ds[0].at} → ${ds.at(-1).after}</span></div>` +
      (hits.length ? `<div class="hit">拿到 ${hits.map(d => `${esc(d.cat.name)}（${d.at}）`).join("、")}</div>` : "") +
      (sw.length ? `<div class="small" style="color:var(--switch)">換列：${sw.map(d => `${d.at}→${d.after}`).join("、")}</div>` : "") +
      `<details><summary>每一抽的角色</summary><ol class="draws">${ds.map(drawRow).join("")}</ol></details></li>`;
  }).join("");
  return { head, items };
}

function costLine(c) {
  const tLeft = progress.tickets - c.t, fLeft = progress.food - c.food;
  return `<div class="cost"><span>共 ${c.draws} 抽</span>` +
    `<span>${icon("t")} 金券 ${c.t} 張・${tLeft >= 0 ? `剩 ${tLeft}` : `<span class="short">差 ${-tLeft}</span>`}</span>` +
    `<span>${icon("f")} 罐頭 ${c.food} 個・${fLeft >= 0 ? `剩 ${fLeft}` : `<span class="short">差 ${-fLeft}</span>`}</span>` +
    [["p", "plat"], ["l", "legend"]].filter(([k]) => c[k]).map(([k, a]) => {
      const left = progress[a] - c[k];
      return `<span>${XTAG(a)} ${ACTION_LABEL[a]} ${c[k]} 張・${left >= 0 ? `剩 ${left}` : `<span class="short">差 ${-left}</span>`}</span>`;
    }).join("") + `</div>`;
}

function confirmBox(kind, steps) {
  const c = cost(steps);
  const next = glabel(steps.at(-1).next);
  if (ui.confirm !== kind) return `<button class="primary" data-ask="${kind}" ${affordable(c) ? "" : "disabled"}>` +
    (kind === "plan" ? "照這個抽完了，存進度" : "已實抽，存進度") + "</button>";
  return `<div class="confirm"><b>確定存成這樣？</b><div>下一抽 <span class="mono">${progress.position} → ${next}</span></div>` +
    `<div>金券 ${progress.tickets} → ${progress.tickets - c.t} 張、罐頭 ${progress.food} → ${progress.food - c.food} 個` +
    (c.p ? `、白金券 ${progress.plat} → ${progress.plat - c.p} 張` : "") + (c.l ? `、傳說券 ${progress.legend} → ${progress.legend - c.l} 張` : "") + `</div>` +
    `<div class="row"><button class="primary" data-commit="${kind}" ${busy ? "disabled" : ""}>確定存</button><button class="ghost" data-cancel>取消</button></div></div>`;
}

function savedBox() {
  return `<div class="box"><span class="${/^已存/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span></div>`;
}

function renderPlan() {
  const out = $("plan-out");
  if (ui.saved && !ui.plan) { out.innerHTML = savedBox(); return; }
  if (!ui.plan) { out.innerHTML = ""; return; }
  const p = ui.plan;
  if (p.error) { out.innerHTML = `<div class="box">${esc(p.error)}</div>`; return; }
  const c = cost(p.steps);
  const { head, items } = renderStages(p.steps);
  const short = !affordable(c);
  out.innerHTML = (ui.saved ? savedBox() : "") + `<div class="box"><div class="plan-head">${head}</div>${costLine(c)}` +
    (short ? `<div class="note">目前的金券或罐頭不夠，上面是不管餘額時最少要花的量。</div>` : "") +
    `<ol class="steps">${items}</ol><div class="note">抽完下一抽是 <span class="mono">${glabel(p.next)}</span>。</div>${confirmBox("plan", p.steps)}</div>`;
}

function findPlan() {
  ui.saved = ""; ui.confirm = null;
  if (!ui.goals.length) { ui.plan = { error: "先在上面選 1～3 個想抽的角色。" }; return renderPlan(); }
  const missing = ui.goals.filter(id => !inPool(id));
  if (missing.length) { ui.plan = { error: `${missing.map(catName).join("、")} 不在這個卡池，換卡池再找。` }; return renderPlan(); }
  const run = limits => E.findPlan(table.start, ui.goals, limits, ui.prio, pool.guaranteedRolls, table.rows, extras);
  const n = ui.goals.length;
  let r = run({ tickets: progress.tickets, eleven: elevenCap(), plat: Math.min(progress.plat, n), legend: Math.min(progress.legend, n) });
  if (!r) {
    const keep = ui.seqRows;
    ui.seqRows = 700; rebuild(); ui.seqRows = keep;
    r = run({ tickets: 300, eleven: 30, plat: n, legend: n });
  }
  ui.plan = r ? { steps: r.steps, next: r.next } : { error: "就算金券 300 張、11 連 30 次，再加上白金券、傳說券，也抽不到全部目標。" };
  renderPlan();
}

// ---------- 手動抽 ----------
function renderManual() {
  const out = $("manual-out");
  const msg = ui.saved ? `<span class="${/^已存/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span>` : "";
  if (!ui.manual.length) { out.innerHTML = msg || `<p class="note" style="margin:0">按上面的按鈕先看會抽到什麼；只是預覽，不會改進度。</p>`; return; }
  const c = cost(ui.manual);
  const list = ui.manual.map((s, i) => `<li class="step"><div class="step-title">${stageTitle({ action: s.action, steps: [s] })}` +
    `<span class="mono muted">#${i + 1}</span></div><ol class="draws">${draws(s).map(drawRow).join("")}</ol></li>`).join("");
  out.innerHTML = msg + `${costLine(c)}<ol class="steps">${list}</ol>` +
    `<div class="note">預覽後下一抽：<span class="mono">${glabel(ui.manual.at(-1).next)}</span> ${esc(ui.manual.at(-1).next.name)}</div>` +
    `<div class="row"><button class="ghost" id="m-undo">撤銷上一步</button><button class="ghost" id="m-clear">全部清掉</button></div>${confirmBox("manual", ui.manual)}`;
}

function manualStep(action) {
  ui.saved = ""; ui.confirm = null;
  const from = ui.manual.at(-1)?.next ?? table.start;
  const s = stepFrom(from, action);
  if (s) ui.manual.push(s);
  renderManual();
}

// ---------- 存進度 ----------
async function commit(kind) {
  if (busy) return;
  const steps = kind === "plan" ? ui.plan.steps : ui.manual;
  const c = cost(steps);
  const lastCat = steps.at(-1).cats.at(-1);
  const to = glabel(steps.at(-1).next);
  const st = E.stateAfter(lastCat);
  const got = steps.flatMap(draws).filter(d => d.cat.rarity >= 4).map(d => `${d.cat.name}（${d.at}）`);
  const entry = {
    time: new Date().toLocaleString("sv-SE"), from: progress.position, to, event: ui.event,
    steps: stagesOf(steps).map(s => s.action === "eleven" ? "11連" : `${ACTION_LABEL[s.action]}×${s.steps.length}`).join(" → "),
    got, tickets: c.t, food: c.food, plat: c.p, legend: c.l, via: kind === "plan" ? "找抽法" : "手動抽",
  };
  const next = { ...progress, seed: st.seed, last: st.last, position: to, event: ui.event,
    tickets: progress.tickets - c.t, food: progress.food - c.food, plat: progress.plat - c.p, legend: progress.legend - c.l,
    history: [entry, ...(progress.history || [])] };
  ui.confirm = kind;
  renderPlan(); renderManual();
  const ok = await persist(next, `抽卡 ${entry.from} → ${to}`);
  if (!ok) return;
  ui.plan = null; ui.manual = []; ui.confirm = null;
  ui.saved = `已存：下一抽 ${to}（上一抽 ${lastCat.name}）`;
  rebuild(); renderAll();
}

// ---------- 序列 ----------
function renderSeq() {
  const start = table.start;
  $("seq").innerHTML = table.rows.slice(0, ui.seqRows).map(row => `<div class="seq-row">${row.map(cat => {
    const now = cat === start || cat.rerolled === start;
    return `<div class="cell ${rarityCls(cat)} ${now ? "now" : ""} ${isTarget(cat.id) ? "target" : ""}">` +
      `<span class="mono">${glabel(cat)}</span><span class="nm">${esc(cat.name)}</span>` +
      (cat.rerolled ? `<span class="alt">重複時 → ${esc(cat.rerolled.name)}</span>` : "") +
      extras.map(x => { const c = extraCell(x, cat); return c ? `<span class="xl ${isTarget(c.id) ? "hit" : ""}">${x.label}：${esc(c.name)}</span>` : ""; }).join("") + "</div>";
  }).join("")}</div>`).join("");
}

function renderAll() { renderStatus(); renderPools(); renderChips(); renderPlan(); renderManual(); renderSeq(); }

// ---------- 連線 ----------
function showSetup(message, canCancel) {
  $("loading").hidden = true;
  $("setup").hidden = false;
  $("setup-err").hidden = !message;
  $("setup-err").textContent = message || "";
  $("setup-cancel").hidden = !canCancel;
  if (!progress) sync("未連線");
}

async function connect(t) {
  $("setup").hidden = true;
  $("loading").hidden = false;
  $("loading").textContent = "正在讀取進度…";
  const prev = token;
  token = t;
  try {
    await reload();
    store.set(t);
    $("loading").hidden = true;
    $("main").hidden = false;
    $("foot").hidden = false;
    renderAll();
  } catch (err) {
    token = prev;
    showSetup(err instanceof GH.AuthError ? err.message : `讀不到進度：${err.message}`, !!progress);
    if (progress) { $("main").hidden = false; }
  }
}

// ---------- 事件 ----------
function setTab(name) {
  for (const t of ["plan", "manual", "seq"]) {
    $("tab-" + t).setAttribute("aria-selected", String(t === name));
    $("panel-" + t).hidden = t !== name;
  }
}

function bind() {
  for (const t of ["plan", "manual", "seq"]) $("tab-" + t).onclick = () => setTab(t);
  for (const img of document.querySelectorAll("#ic-t, .ic-t")) img.src = ICON.t;
  for (const img of document.querySelectorAll("#ic-f, .ic-f")) img.src = ICON.f;

  $("pool").onchange = async e => {
    const prev = ui.event;
    ui.event = e.target.value; ui.plan = null; ui.manual = []; ui.saved = "";
    rebuild(); renderAll();
    if (!(await persist({ ...progress, event: ui.event }, "切換卡池"))) { ui.event = prev; rebuild(); renderAll(); }
  };
  const wallet = async () => {
    const tickets = Math.max(0, parseInt($("tickets").value, 10) || 0);
    const food = Math.max(0, parseInt($("food").value, 10) || 0);
    const plat = Math.max(0, parseInt($("plat").value, 10) || 0);
    const legend = Math.max(0, parseInt($("legend").value, 10) || 0);
    if (tickets === progress.tickets && food === progress.food && plat === progress.plat && legend === progress.legend) return;
    ui.plan = null; ui.confirm = null;
    await persist({ ...progress, tickets, food, plat, legend }, "更新抽卡資源");
    rebuild(); renderStatus(); renderPlan(); renderManual();
  };
  for (const id of ["tickets", "food", "plat", "legend"]) $(id).onchange = wallet;
  $("q").oninput = () => renderSuggest(true);
  $("q").onfocus = () => renderSuggest(true);
  $("connect").onclick = () => { const v = $("token").value.trim(); if (v) connect(v); };
  $("setup-cancel").onclick = () => { $("setup").hidden = true; };
  $("rekey").onclick = () => { $("token").value = ""; showSetup("", true); $("setup").scrollIntoView(); };

  document.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!e.target.closest(".search")) renderSuggest(false);
    if (!t) return;
    if (t.dataset.id) { if (ui.goals.length < 3) ui.goals.push(+t.dataset.id); $("q").value = ""; ui.plan = null; renderSuggest(false); renderChips(); renderPlan(); renderSeq(); }
    else if (t.dataset.rm) { ui.goals = ui.goals.filter(id => id !== +t.dataset.rm); ui.plan = null; renderChips(); renderPlan(); renderSeq(); }
    else if (t.dataset.p) { ui.prio = t.dataset.p; for (const b of $("prio").children) b.setAttribute("aria-pressed", String(b === t)); if (ui.plan) findPlan(); }
    else if (t.dataset.ask) { ui.confirm = t.dataset.ask; t.dataset.ask === "plan" ? renderPlan() : renderManual(); }
    else if (t.dataset.commit) commit(t.dataset.commit);
    else if (t.hasAttribute("data-cancel")) { ui.confirm = null; renderPlan(); renderManual(); }
    else if (t.id === "find") findPlan();
    else if (t.id === "m-ticket") manualStep("ticket");
    else if (t.id === "m-eleven") manualStep("eleven");
    else if (t.id === "m-plat") manualStep("plat");
    else if (t.id === "m-legend") manualStep("legend");
    else if (t.id === "m-undo") { ui.manual.pop(); ui.confirm = null; renderManual(); }
    else if (t.id === "m-clear") { ui.manual = []; ui.confirm = null; renderManual(); }
    else if (t.id === "more") { ui.seqRows += 20; if (ui.seqRows > table.rows.length) rebuild(); renderSeq(); }
  });
}

async function main() {
  bind();
  try {
    D = await (await fetch("data/bc-tw.json", { cache: "no-cache" })).json();
  } catch (err) {
    $("loading").textContent = `卡池資料讀不到：${err.message}`;
    return;
  }
  catalog = Object.entries(D.cats).filter(([, c]) => c.rarity >= 4)
    .map(([id, c]) => ({ id: +id, names: [...new Set(c.name)], rarity: c.rarity }))
    .filter(c => c.names[0] && !/^\d/.test(c.names[0]));
  $("data-ver").textContent = `卡池資料 ${D.built}`;
  token = store.get();
  if (token) connect(token);
  else showSetup("", false);
}

main();
