import * as E from "./engine.mjs";
import * as GH from "./github.mjs";
import * as P from "./planner.mjs";

const TOKEN_KEY = "bcg-token";
const ICON = { t: "img/ticket.png", f: "img/food.png", p: "img/plat.png", l: "img/legend.png" };
const ACTION_LABEL = { ticket: "金券", eleven: "11 連", plat: "白金券", legend: "傳說券" };
const ACTION_ICON = { ticket: "t", eleven: "f", plat: "p", legend: "l" };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
  set: v => { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
};

let D, token = "", sha = null, progress = null, busy = false;
const ui = { event: null, off: new Set(), prio: "draws", plan: null, hint: null, seqRows: 20, confirm: null, saved: "", calib: null, undo: false };
let pool, table, base, world;

const today = () => new Date().toLocaleDateString("sv-SE");
const glabel = cat => E.labelOf(base + E.cellIndex(cat));
const rarityCls = cat => cat.rarity === 4 ? "uber" : cat.rarity === 5 ? "legend" : "";
const wishlist = () => progress.wishlist || [];
const goals = () => wishlist().filter(id => !ui.off.has(id));
const isTarget = id => goals().includes(id);
const icon = k => `<img class="icon" src="${ICON[k]}" alt="">`;
const catName = id => D.cats[id]?.name?.[0] ?? String(id);
const poolName = (key, w = world) => w.pools.find(p => p.key === key)?.name ?? "";
const rowsOf = key => world.pools.find(p => p.key === key)?.rows ?? table.rows;
const extraCell = (x, cat) => { const i = E.cellIndex(cat); return x.rows[i >> 1]?.[i & 1]; };
const snapshot = p => ({ seed: p.seed, last: p.last, position: p.position, event: p.event,
  tickets: p.tickets, food: p.food, plat: p.plat, legend: p.legend });

function sync(text, bad = false) {
  $("sync").textContent = text;
  $("sync").classList.toggle("bad", bad);
}

function rebuild() {
  // 找抽法在「不管餘額」時最多會用到金券 300 張、11 連 30 次，表格要夠長
  const count = Math.min(1200, Math.max(720, ui.seqRows + 10));
  pool = E.makePool(D, ui.event);
  table = E.buildTable(pool, { seed: progress.seed, last: progress.last, count });
  base = E.indexOf(progress.position);
  world = P.buildWorld(D, progress, today(), { count, first: ui.event });
}
const worldOpts = () => ({ count: Math.min(1200, Math.max(720, ui.seqRows + 10)), first: ui.event });

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
      renderPlan(); renderLog(); renderCalib();
    }
    return false;
  } finally {
    busy = false;
  }
}

async function reload() {
  const r = await GH.load(token);
  progress = r.data; sha = r.sha;
  progress.plat ??= 0; progress.legend ??= 0; progress.wishlist ??= [];
  ui.event = D.events[progress.event] && !D.events[progress.event].k ? progress.event : P.openPools(D, today())[0]?.key;
  ui.plan = null; ui.hint = null; ui.confirm = null; ui.calib = null; ui.undo = false;
  rebuild();
  sync("已同步");
}

// ---------- 抽卡步驟 ----------
function draws(step) {
  return step.cats.map((cat, i) => {
    const isG = /G$/.test(cat.extraLabel || "");
    const atCat = isG ? step.cats[i - 1].next : cat;
    const at = glabel(atCat), after = cat.next ? glabel(cat.next) : "";
    // 重複稀有換列：原本這格抽到的貓跟上一抽一樣，改成另一隻並跳到別列
    const ci = E.cellIndex(cat);
    const rows = rowsOf(step.pool);
    const dup = /R/.test(cat.extraLabel || "") ? rows[ci >> 1]?.[ci & 1]?.name : null;
    return { cat, at, after, dup, guaranteed: isG, switched: after && at.slice(-1) !== after.slice(-1) };
  });
}

const cost = P.costOf;
const affordable = c => P.affordable(c, progress);

function stagesOf(steps) {
  const stages = [];
  for (const s of steps) {
    const prev = stages.at(-1);
    if (s.action === prev?.action && s.pool === prev?.pool && s.action !== "eleven") prev.steps.push(s);
    else stages.push({ action: s.action, pool: s.pool, steps: [s] });
  }
  return stages;
}
const stagesText = (steps, w = world) => stagesOf(steps).map(s =>
  (s.action === "eleven" ? "11連" : `${ACTION_LABEL[s.action]}×${s.steps.length}`) +
  (poolName(s.pool, w) ? `@${poolName(s.pool, w)}` : "")).join(" → ");

// ---------- 頂部狀態與卡池 ----------
function renderStatus() {
  const start = table.start;
  $("pos").textContent = progress.position;
  $("next-name").textContent = start.name;
  $("next-name").style.color = start.rarity === 4 ? "var(--uber)" : start.rarity === 5 ? "var(--legend)" : "";
  const g = pool.guaranteedRolls === 11 && start.guaranteed;
  $("next-g").textContent = g ? `從這格開 11 連，保證拿到 ${start.guaranteed.name}` : "這個卡池的 11 連沒有保證超激";
  $("next-x").textContent = world.extras.map(x => `${x.label}這格：${extraCell(x, start)?.name ?? "—"}`).join("｜");
  for (const k of ["tickets", "food", "plat", "legend"]) $(k).value = progress[k];
  const ev = D.events[ui.event];
  const pct = n => (n / 100).toFixed(n % 100 ? 1 : 0) + "%";
  const md = s => s.slice(5).replace("-", "/");
  const legend = 10000 - ev.rare - ev.supa - ev.uber;
  $("pool-meta").textContent = `${md(ev.s)}～${md(ev.e)}・超激 ${pct(ev.uber)}` +
    (legend > 0 ? `・傳說 ${pct(legend)}` : "") + (ev.guaranteed ? "・11 連保證超激" : "") +
    (ev.e < today() ? "・已結束" : "");
  $("plan-note").textContent = `找抽法會一起比較今天開著的 ${world.pools.length} 個一般卡池，` +
    world.extras.map(x => `${x.label}（${md(D.events[x.key].s)} 版）`).join("、") + "，路線中途可以換池。";
}

function renderPools() {
  const sel = $("pool");
  const list = Object.entries(D.events).map(([k, e]) => ({ k, e })).filter(x => !x.e.k);
  const now = list.filter(x => x.e.e >= today()).sort((a, b) => a.e.s.localeCompare(b.e.s));
  const past = list.filter(x => x.e.e < today()).sort((a, b) => b.e.s.localeCompare(a.e.s));
  const opt = x => `<option value="${x.k}">${esc(x.e.s.slice(5).replace("-", "/"))} ${esc(x.e.n.replace(/★.*$/, ""))}</option>`;
  sel.innerHTML = `<optgroup label="進行中與即將登場">${now.map(opt).join("")}</optgroup>` +
    `<optgroup label="過往卡池">${past.map(opt).join("")}</optgroup>`;
  sel.value = ui.event;
}

// ---------- 想要清單 ----------
let catalog = [];
const norm = s => s.normalize("NFKC").toLowerCase();
const sources = id => P.sourcesOf(world, id);

function renderSuggest(open) {
  const box = $("suggest"), q = norm($("q").value.trim());
  if (!open) { box.hidden = true; $("q").setAttribute("aria-expanded", "false"); return; }
  const hits = catalog.filter(c => !wishlist().includes(c.id))
    .map(c => ({ c, r: !q ? 0 : c.names.some(n => norm(n).startsWith(q)) ? 0 : c.names.some(n => norm(n).includes(q)) ? 1 : 2 }))
    .filter(h => h.r < 2 && (q || sources(h.c.id).length))
    .sort((a, b) => a.r - b.r || a.c.names[0].localeCompare(b.c.names[0], "zh-Hant"));
  const group = (title, arr) => arr.length ? `<div class="grp">${title}（${arr.length}）</div>` +
    arr.slice(0, 40).map(h => `<button data-id="${h.c.id}">${esc(h.c.names[0])}${h.c.rarity === 5 ? "（傳說稀有）" : ""}` +
      `${sources(h.c.id).length ? `<span class="muted small">・${sources(h.c.id).join("、")}</span>` : ""}</button>`).join("") : "";
  const yes = hits.filter(h => sources(h.c.id).length), no = hits.filter(h => !sources(h.c.id).length);
  box.innerHTML = group("現在抽得到", yes) + group("現在抽不到", no) || `<div class="grp">找不到符合的角色</div>`;
  box.hidden = false;
  $("q").setAttribute("aria-expanded", "true");
}

function renderChips() {
  $("chips").innerHTML = wishlist().map(id => {
    const src = sources(id), off = ui.off.has(id);
    return `<span class="chip ${src.length ? "" : "out"} ${off ? "off" : ""}">` +
      `<button class="chip-name" data-toggle="${id}" aria-pressed="${!off}" title="${off ? "這次不算，點一下加回來" : "點一下這次先不算"}">` +
      `${esc(catName(id))}・${src.length ? src.join("、") : "現在抽不到"}${off ? "・這次不算" : ""}</button>` +
      `<button data-rm="${id}" aria-label="從想要清單移除 ${esc(catName(id))}">×</button></span>`;
  }).join("");
}

async function setWishlist(list, message) {
  ui.plan = null; ui.hint = null; ui.saved = "";
  await persist({ ...progress, wishlist: list }, message);
  renderChips(); renderPlan(); renderSeq();
}

// ---------- 找抽法 ----------
function drawRow(d) {
  return `<li class="draw ${rarityCls(d.cat)} ${isTarget(d.cat.id) ? "target" : ""}"><span class="mono">${d.at}</span>` +
    `<span class="nm">${esc(d.cat.name)}${d.dup ? `<span class="muted small">（${esc(d.dup)} 重複）</span>` : ""}</span>` +
    `${d.switched ? `<span class="sw">${d.guaranteed ? "必中" : "重複"}換到 ${d.after}</span>` : "<span></span>"}</li>`;
}

function stageHead(st) {
  return st.action === "eleven" ? `${icon("f")}11 連` : `${icon(ACTION_ICON[st.action])}× ${st.steps.length}`;
}
function stageTitle(st) {
  const where = poolName(st.pool) ? `<span class="muted small">・${esc(poolName(st.pool))}</span>` : "";
  if (st.action === "eleven") return icon("f") + "11 連抽" + where;
  return icon(ACTION_ICON[st.action]) + `${ACTION_LABEL[st.action]} × ${st.steps.length}` + where;
}

function renderStages(steps) {
  const stages = stagesOf(steps);
  const head = stages.map((st, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="seg-item">${stageHead(st)}</span>`).join("");
  const items = stages.map(st => {
    const ds = st.steps.flatMap(draws);
    const hits = ds.filter(d => isTarget(d.cat.id));
    const sw = ds.filter(d => d.switched && !d.guaranteed);
    return `<li class="step"><div class="step-title">${stageTitle(st)}` +
      `<span class="mono muted">${ds[0].at} → ${ds.at(-1).after}</span></div>` +
      (hits.length ? `<div class="hit">拿到 ${hits.map(d => `${esc(d.cat.name)}（${d.at}）`).join("、")}</div>` : "") +
      sw.map(d => `<div class="small" style="color:var(--switch)">換列：${d.at} ${d.dup ? `原本是 ${esc(d.dup)}，跟上一抽重複，改成 ${esc(d.cat.name)}` : "必中"}，下一抽跳到 ${d.after}</div>`).join("") +
      `<details><summary>每一抽的角色</summary><ol class="draws">${ds.map(drawRow).join("")}</ol></details></li>`;
  }).join("");
  return { head, items };
}

function costLine(c) {
  const part = (k, label, used, unit, have) => {
    const left = have - used;
    return `<span>${icon(k)} ${label} ${used} ${unit}・${left >= 0 ? `剩 ${left}` : `<span class="short">差 ${-left}</span>`}</span>`;
  };
  return `<div class="cost"><span>共 ${c.draws} 抽</span>` +
    part("t", "金券", c.t, "張", progress.tickets) + part("f", "罐頭", c.food, "個", progress.food) +
    (c.p ? part("p", "白金券", c.p, "張", progress.plat) : "") + (c.l ? part("l", "傳說券", c.l, "張", progress.legend) : "") + `</div>`;
}

function confirmBox(steps) {
  const c = cost(steps);
  const next = glabel(steps.at(-1).next);
  if (ui.confirm !== "plan") return `<button class="primary" data-ask="plan" ${affordable(c) ? "" : "disabled"}>照這個抽完了，存進度</button>`;
  return `<div class="confirm"><b>確定存成這樣？</b><div>下一抽 <span class="mono">${progress.position} → ${next}</span></div>` +
    `<div>金券 ${progress.tickets} → ${progress.tickets - c.t} 張、罐頭 ${progress.food} → ${progress.food - c.food} 個` +
    (c.p ? `、白金券 ${progress.plat} → ${progress.plat - c.p} 張` : "") + (c.l ? `、傳說券 ${progress.legend} → ${progress.legend - c.l} 張` : "") + `</div>` +
    `<div class="row"><button class="primary" data-commit="plan" ${busy ? "disabled" : ""}>確定存</button><button class="ghost" data-cancel>取消</button></div></div>`;
}

const savedBox = () => `<div class="box"><span class="${/^已/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span></div>`;

function hintBox(h) {
  const md = s => s.slice(5).replace("-", "/");
  const now = cost(ui.plan.steps);
  const fewer = [];
  if (h.cost.p + h.cost.l < now.p + now.l) fewer.push(`少用白金／傳說券 ${now.p + now.l - h.cost.p - h.cost.l} 張`);
  if (h.cost.draws < now.draws) fewer.push(`少 ${now.draws - h.cost.draws} 抽`);
  return `<div class="box hint"><b>等 ${md(h.date)} ${esc(h.opened.join("、"))} 開了再抽，會比較省</b>` +
    `<div class="small">${esc(stagesText(h.plan.steps, h.world))}</div>${costLine(h.cost)}` +
    `<div class="note">比現在抽${fewer.join("、")}。上面是現在就抽的抽法。</div></div>`;
}

function renderPlan() {
  const out = $("plan-out");
  if (ui.saved && !ui.plan) { out.innerHTML = savedBox(); return; }
  if (!ui.plan) { out.innerHTML = ""; return; }
  const p = ui.plan;
  const skipped = p.skipped?.length ? `<div class="note">${esc(p.skipped.map(catName).join("、"))} 現在哪一池都抽不到，這次先不算。</div>` : "";
  if (p.error) { out.innerHTML = `<div class="box">${esc(p.error)}${skipped}</div>`; return; }
  const c = cost(p.steps);
  const { head, items } = renderStages(p.steps);
  out.innerHTML = (ui.saved ? savedBox() : "") + `<div class="box"><div class="plan-head">${head}</div>${costLine(c)}` +
    (affordable(c) ? "" : `<div class="note">目前的抽卡資源不夠，上面是不管餘額時最少要花的量，紅字是差多少。</div>`) + skipped +
    `<ol class="steps">${items}</ol><div class="note">抽完下一抽是 <span class="mono">${E.labelOf(base + p.index)}</span>。</div>${confirmBox(p.steps)}</div>` +
    (ui.hint ? hintBox(ui.hint) : "");
}

function findPlan() {
  ui.saved = ""; ui.confirm = null; ui.hint = null;
  const all = goals();
  if (!all.length) { ui.plan = { error: wishlist().length ? "想要清單裡的角色這次都設成不算了。" : "先在上面加入想要的角色。" }; return renderPlan(); }
  const skipped = all.filter(id => !sources(id).length);
  const g = all.filter(id => sources(id).length);
  if (!g.length) { ui.plan = { error: "這些角色現在哪一池都抽不到。", skipped: [] }; return renderPlan(); }
  const r = P.bestPlan(world, progress, g, ui.prio);
  ui.plan = r.error ? { error: r.error, skipped } : { steps: r.steps, index: r.index, skipped };
  if (!r.error) ui.hint = P.waitHint(D, progress, today(), g, ui.prio, r, worldOpts());
  renderPlan();
}

// ---------- 存進度 ----------
async function commit() {
  if (busy) return;
  const steps = ui.plan.steps;
  const c = cost(steps);
  const lastCat = steps.at(-1).cats.at(-1);
  const to = glabel(steps.at(-1).next);
  const st = E.stateAfter(lastCat);
  const got = steps.flatMap(draws).filter(d => d.cat.rarity >= 4).map(d => `${d.cat.name}（${d.at}）`);
  const entry = {
    type: "抽卡", time: new Date().toLocaleString("sv-SE"), from: progress.position, to,
    steps: stagesText(steps), got, tickets: c.t, food: c.food, plat: c.p, legend: c.l, via: "找抽法",
    before: snapshot(progress),
  };
  const next = { ...progress, seed: st.seed, last: st.last, position: to, event: ui.event,
    tickets: progress.tickets - c.t, food: progress.food - c.food, plat: progress.plat - c.p, legend: progress.legend - c.l,
    history: [entry, ...(progress.history || [])] };
  renderPlan();
  if (!(await persist(next, `抽卡 ${entry.from} → ${to}`))) return;
  ui.plan = null; ui.hint = null; ui.confirm = null;
  ui.saved = `已存：下一抽 ${to}（上一抽 ${lastCat.name}）`;
  rebuild(); renderAll();
}

// ---------- 序列與校正位置 ----------
function renderSeq() {
  const start = table.start;
  $("seq").innerHTML = table.rows.slice(0, ui.seqRows).map(row => `<div class="seq-row">${row.map(cat => {
    const now = cat === start || cat.rerolled === start;
    const k = E.cellIndex(cat);
    return `<button class="cell ${rarityCls(cat)} ${now ? "now" : ""} ${isTarget(cat.id) ? "target" : ""} ${ui.calib?.k === k ? "picked" : ""}" data-cell="${k}">` +
      `<span class="mono">${glabel(cat)}</span><span class="nm">${esc(cat.name)}</span>` +
      (cat.rerolled ? `<span class="alt">重複時 → ${esc(cat.rerolled.name)}</span>` : "") +
      world.extras.map(x => { const c = extraCell(x, cat); return c ? `<span class="xl ${isTarget(c.id) ? "hit" : ""}">${x.label}：${esc(c.name)}</span>` : ""; }).join("") + "</button>";
  }).join("")}</div>`).join("");
}

// 校正：把下一抽改到第 k 格（以目前下一抽為 0）。上一抽只影響「這格會不會因重複換列」
function pickCalib(k) {
  if (!Number.isInteger(k) || Math.abs(k) > 2000) return;
  const seed = E.seedAt(progress.seed, k);
  // 往回校正時目前的表格沒有那幾格，用新種子另外算一張只看第一格
  const cand = new Map();
  for (const p of world.pools) {
    const rows = k >= 0 ? p.rows : E.buildTable(p.pool, { seed, last: 0, count: 1 }).rows;
    const i = k >= 0 ? k : 0;
    const c = rows[i >> 1]?.[i & 1];
    if (c && c.rarity === E.Rare) cand.set(c.id, c.name);
  }
  ui.calib = { k, seed, label: E.labelOf(base + k), cand: [...cand] };
  ui.saved = "";
  renderCalib(); renderSeq();
}

function renderCalib() {
  const out = $("calib");
  if (ui.saved && !ui.calib) { out.innerHTML = `<span class="${/^已/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span>`; return; }
  if (!ui.calib) { out.innerHTML = ""; return; }
  const c = ui.calib;
  out.innerHTML = `<div class="confirm"><b>把下一抽從 <span class="mono">${progress.position}</span> 改成 <span class="mono">${c.label}</span>？</b>` +
    (c.cand.length ? `<div class="small">${esc(c.label)} 會不會換列，要看上一抽拿到誰：</div>` +
      [...c.cand.map(([id, name]) => `<label class="radio"><input type="radio" name="calib-last" value="${id}"> 上一抽是 ${esc(name)}（${esc(c.label)} 會重複換列）</label>`),
        `<label class="radio"><input type="radio" name="calib-last" value="0" checked> 上一抽不是上面這些</label>`].join("")
      : `<div class="small">這格不會因為重複換列，不用管上一抽是誰。</div>`) +
    `<div class="row"><button class="primary" id="calib-ok" ${busy ? "disabled" : ""}>確定改</button><button class="ghost" id="calib-cancel">取消</button></div></div>`;
}

async function commitCalib() {
  if (busy || !ui.calib) return;
  const c = ui.calib;
  const last = +(document.querySelector('input[name="calib-last"]:checked')?.value || 0);
  const entry = { type: "校正", time: new Date().toLocaleString("sv-SE"), from: progress.position, to: c.label, before: snapshot(progress) };
  const next = { ...progress, seed: c.seed, last, position: c.label, history: [entry, ...(progress.history || [])] };
  if (!(await persist(next, `校正位置 ${entry.from} → ${c.label}`))) return;
  ui.calib = null; ui.plan = null; ui.hint = null;
  ui.saved = `已校正：下一抽改成 ${c.label}`;
  rebuild(); renderAll();
}

// ---------- 抽卡紀錄與復原 ----------
function renderLog() {
  const list = progress.history || [];
  const msg = ui.saved && $("panel-log").hidden === false ? `<span class="${/^已/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span>` : "";
  const top = list[0];
  const undo = top?.before ? (ui.undo
    ? `<div class="confirm"><b>復原最近這次存檔？</b><div>下一抽 <span class="mono">${progress.position} → ${top.before.position}</span>` +
      (top.type === "抽卡" ? `，金券、罐頭、白金券、傳說券退回存檔前的數字` : "") + `</div>` +
      `<div class="row"><button class="primary" id="undo-ok" ${busy ? "disabled" : ""}>確定復原</button><button class="ghost" id="undo-cancel">取消</button></div></div>`
    : `<button class="ghost" id="undo-ask">復原最近這次存檔</button>`) : "";
  $("log").innerHTML = msg + undo + (list.length ? `<ol class="steps">${list.map(h => `<li class="step">` +
    `<div class="step-title"><span class="mono">${esc(h.from)} → ${esc(h.to)}</span><span class="muted small">${esc(h.type || "抽卡")}・${esc(h.time)}</span></div>` +
    (h.steps ? `<div class="small">${esc(h.steps)}</div>` : "") +
    (h.got?.length ? `<div class="hit small">拿到 ${esc(h.got.join("、"))}</div>` : "") +
    (h.type === "校正" ? "" : `<div class="cost">${[["t", "金券", h.tickets, "張"], ["f", "罐頭", h.food, "個"], ["p", "白金券", h.plat, "張"], ["l", "傳說券", h.legend, "張"]]
      .filter(([, , v]) => v).map(([k, n, v, u]) => `<span>${icon(k)} ${n} ${v} ${u}</span>`).join("")}</div>`) +
    `</li>`).join("")}</ol>` : `<p class="note" style="margin:0">還沒有紀錄。</p>`);
}

async function commitUndo() {
  const [top, ...rest] = progress.history || [];
  if (busy || !top?.before) return;
  const next = { ...progress, ...top.before, history: rest };
  if (!(await persist(next, `復原：${top.from} → ${top.to}`))) return;
  ui.undo = false; ui.plan = null; ui.hint = null; ui.event = next.event && D.events[next.event] ? next.event : ui.event;
  ui.saved = `已復原：下一抽回到 ${top.before.position}`;
  rebuild(); renderAll();
}

function renderAll() { renderStatus(); renderPools(); renderChips(); renderPlan(); renderSeq(); renderCalib(); renderLog(); }

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
    if (progress) $("main").hidden = false;
  }
}

// ---------- 事件 ----------
const TABS = ["plan", "seq", "log"];
function setTab(name) {
  for (const t of TABS) {
    $("tab-" + t).setAttribute("aria-selected", String(t === name));
    $("panel-" + t).hidden = t !== name;
  }
  ui.saved = "";
  renderLog(); renderCalib();
}

function bind() {
  for (const t of TABS) $("tab-" + t).onclick = () => setTab(t);
  for (const [k, src] of Object.entries(ICON)) for (const img of document.querySelectorAll(`.ic-${k}`)) img.src = src;

  $("pool").onchange = async e => {
    const prev = ui.event;
    ui.event = e.target.value; ui.plan = null; ui.hint = null; ui.saved = ""; ui.calib = null;
    rebuild(); renderAll();
    if (!(await persist({ ...progress, event: ui.event }, "切換卡池"))) { ui.event = prev; rebuild(); renderAll(); }
  };
  const wallet = async () => {
    const v = id => Math.max(0, parseInt($(id).value, 10) || 0);
    const w = { tickets: v("tickets"), food: v("food"), plat: v("plat"), legend: v("legend") };
    if (Object.keys(w).every(k => w[k] === progress[k])) return;
    ui.plan = null; ui.hint = null; ui.confirm = null;
    await persist({ ...progress, ...w }, "更新抽卡資源");
    renderStatus(); renderPlan();
  };
  for (const id of ["tickets", "food", "plat", "legend"]) $(id).onchange = wallet;
  $("q").oninput = () => renderSuggest(true);
  $("q").onfocus = () => renderSuggest(true);
  $("connect").onclick = () => { const v = $("token").value.trim(); if (v) connect(v); };
  $("setup-cancel").onclick = () => { $("setup").hidden = true; };
  $("rekey").onclick = () => { $("token").value = ""; showSetup("", true); $("setup").scrollIntoView(); };
  $("goto").onclick = () => {
    const label = $("goto-cell").value.trim().toUpperCase();
    if (!/^\d+[AB]$/.test(label)) { ui.saved = "格號要像 195A、207B 這樣"; ui.calib = null; return renderCalib(); }
    pickCalib(E.indexOf(label) - base);
  };

  document.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!e.target.closest(".search")) renderSuggest(false);
    if (!t) return;
    if (t.dataset.id) { $("q").value = ""; renderSuggest(false); setWishlist([...wishlist(), +t.dataset.id], `想要清單加入 ${catName(+t.dataset.id)}`); }
    else if (t.dataset.rm) setWishlist(wishlist().filter(id => id !== +t.dataset.rm), `想要清單移除 ${catName(+t.dataset.rm)}`);
    else if (t.dataset.toggle) { const id = +t.dataset.toggle; ui.off.has(id) ? ui.off.delete(id) : ui.off.add(id); ui.plan = null; ui.hint = null; renderChips(); renderPlan(); renderSeq(); }
    else if (t.dataset.p) { ui.prio = t.dataset.p; for (const b of $("prio").children) b.setAttribute("aria-pressed", String(b === t)); if (ui.plan) findPlan(); }
    else if (t.dataset.ask) { ui.confirm = "plan"; renderPlan(); }
    else if (t.dataset.commit) commit();
    else if (t.hasAttribute("data-cancel")) { ui.confirm = null; renderPlan(); }
    else if (t.dataset.cell) pickCalib(+t.dataset.cell);
    else if (t.id === "calib-ok") commitCalib();
    else if (t.id === "calib-cancel") { ui.calib = null; renderCalib(); renderSeq(); }
    else if (t.id === "undo-ask") { ui.undo = true; renderLog(); }
    else if (t.id === "undo-cancel") { ui.undo = false; renderLog(); }
    else if (t.id === "undo-ok") commitUndo();
    else if (t.id === "find") findPlan();
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
