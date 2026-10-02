import * as E from "../js/engine.mjs";
import * as GH from "../js/github.mjs";
import * as P from "../js/planner.mjs";

const TOKEN_KEY = "bcg-token";
const ICON = { t: "../img/ticket.png", f: "../img/food.png", p: "../img/plat.png", l: "../img/legend.png" };
const ICON_ALT = { t: "金券", f: "罐頭", p: "白金券", l: "傳說券" };
const ACTION_ICON = { ticket: "t", eleven: "f", plat: "p", legend: "l" };
const SOURCE_ICON = { 一般: "t", 白金: "p", 傳說: "l" };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
  set: v => { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
};
const desktop = matchMedia("(min-width: 900px)");

let D, token = "", sha = null, progress = null, busy = false;
const ui = { route: new Map(), focus: null, event: null, off: new Set(), prio: "draws", plan: null, hint: null, seqRows: 20, confirm: null, saved: "",
  calib: null, undo: false, tab: "plan", side: "seq" };
let pool, table, base, world;

const today = () => new Date().toLocaleDateString("sv-SE");
const glabel = cat => E.labelOf(base + E.cellIndex(cat));
const rarityCls = cat => cat.rarity === 5 ? "legend" : cat.info?.blue ? "blue" : "";
const wishlist = () => progress.wishlist || [];
const goals = () => wishlist().filter(id => !ui.off.has(id));
const isTarget = id => goals().includes(id);
const icon = (k, cls = "") => `<img class="icon ${cls}" src="${ICON[k]}" alt="${ICON_ALT[k]}">`;
const catName = id => D.cats[id]?.name?.[0] ?? String(id);
const poolName = (key, w = world) => w.pools.find(p => p.key === key)?.name ?? "";
const rowsOf = key => world.pools.find(p => p.key === key)?.rows ?? table.rows;
const extraCell = (x, cat) => { const i = E.cellIndex(cat); return x.rows[i >> 1]?.[i & 1]; };
// 白金、傳說在同一格出的超激通常一樣，一樣就合成一行
function extraLines(cat, cls = "") {
  const got = world.extras.map(x => ({ k: x.action === "plat" ? "p" : "l", c: extraCell(x, cat) })).filter(g => g.c);
  const groups = [];
  for (const g of got) {
    const same = groups.find(x => x.c.id === g.c.id);
    same ? same.ks.push(g.k) : groups.push({ ks: [g.k], c: g.c });
  }
  return groups.map(g => `<span class="${cls} ${rarityCls(g.c)} ${isTarget(g.c.id) ? "hit" : ""}">${g.ks.map(k => icon(k, "sm")).join("")}${esc(g.c.name)}</span>`).join("");
}
const snapshot = p => ({ seed: p.seed, last: p.last, position: p.position, event: p.event,
  tickets: p.tickets, food: p.food, plat: p.plat, legend: p.legend });
const md = s => s.slice(5).replace("-", "/");
const msgHtml = () => ui.saved ? `<span class="${/^已/.test(ui.saved) ? "ok" : "err"}">${esc(ui.saved)}</span>` : "";

function sync(state, text) {
  $("sync").className = "dot " + (state || "");
  $("sync").setAttribute("aria-label", text);
  $("sync").title = text;
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
  sync("", "存檔中");
  try {
    sha = await GH.save(token, next, sha, message);
    progress = next;
    sync("good", "已存到 GitHub");
    return true;
  } catch (err) {
    if (err instanceof GH.ConflictError) {
      await reload();
      ui.saved = "進度在別的地方改過，已載入最新的；請重新確認再存。";
      renderAll();
    } else {
      sync("bad", "存檔失敗");
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
  sync("good", "已同步");
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
    else stages.push({ action: s.action, pool: s.pool, steps: [s], no: stages.length + 1 });
  }
  return stages;
}

// 路線經過的格子：格子位置（以下一抽為 0）→ 第幾段、這一抽在第幾個（給序列標示與發光動畫用）
function routeOf(steps) {
  const map = new Map();
  let n = 0;
  for (const st of stagesOf(steps)) for (const d of st.steps.flatMap(draws)) {
    const k = E.indexOf(d.at) - base;
    if (!map.has(k)) map.set(k, { no: st.no, order: n++, extra: st.action === "plat" || st.action === "legend" });
  }
  return map;
}
// 存進紀錄用：結構化，顯示時再換成圖示
const stagesData = (steps, w = world) => stagesOf(steps).map(s => ({ a: s.action, n: s.steps.length, pool: poolName(s.pool, w) || undefined }));
const stagesText = (steps, w = world) => stagesOf(steps).map(s =>
  (s.action === "eleven" ? "11連" : `${{ ticket: "金券", plat: "白金券", legend: "傳說券" }[s.action]}×${s.steps.length}`) +
  (poolName(s.pool, w) ? `@${poolName(s.pool, w)}` : "")).join(" → ");
const stageChip = (a, n) => a === "eleven" ? `${icon("f")}11 連` : `${icon(ACTION_ICON[a])}× ${n}`;
function headOf(steps) {
  const parts = [];
  for (const st of stagesOf(steps)) {
    const prev = parts.at(-1);
    if (prev && prev.a === st.action && st.action !== "eleven") prev.n += st.steps.length;
    else parts.push({ a: st.action, n: st.steps.length });
  }
  return parts.map((p, i) => `${i ? '<span class="arrow">→</span>' : ""}<span class="seg-item">${stageChip(p.a, p.n)}</span>`).join("");
}

// ---------- 頂部狀態列 ----------
function renderBar() {
  $("pos").textContent = progress.position;
  for (const k of ["tickets", "food", "plat", "legend"]) $("m-" + k).textContent = progress[k];
}

function openWallet(open) {
  $("wallet-edit").hidden = !open;
  $("wallet-btn").setAttribute("aria-expanded", String(open));
  if (open) for (const k of ["tickets", "food", "plat", "legend"]) $(k).value = progress[k];
}

async function saveWallet() {
  const v = id => Math.max(0, parseInt($(id).value, 10) || 0);
  const w = { tickets: v("tickets"), food: v("food"), plat: v("plat"), legend: v("legend") };
  if (Object.keys(w).some(k => w[k] !== progress[k])) {
    ui.plan = null; ui.hint = null; ui.confirm = null;
    if (!(await persist({ ...progress, ...w }, "更新抽卡資源"))) return;
  }
  openWallet(false);
  renderBar(); renderPlan();
}

// ---------- 序列頁上方：下一抽與卡池 ----------
function renderNow() {
  const start = table.start;
  const g = pool.guaranteedRolls === 11 && start.guaranteed;
  $("now-info").innerHTML = `<div class="big"><span class="mono">${esc(progress.position)}</span> <span class="${rarityCls(start)}">${esc(start.name)}</span></div>` +
    (g ? `<div class="small">${icon("f", "sm")} 11 連保證 <b>${esc(start.guaranteed.name)}</b></div>` : "") +
    `<div class="extra-now">${extraLines(start)}</div>`;
  const ev = D.events[ui.event];
  $("pool-meta").textContent = `${md(ev.s)}～${md(ev.e)}` + (ev.e < today() ? "・已結束" : "");
}

function renderPools() {
  const sel = $("pool");
  const list = Object.entries(D.events).map(([k, e]) => ({ k, e })).filter(x => !x.e.k);
  const now = list.filter(x => x.e.e >= today()).sort((a, b) => a.e.s.localeCompare(b.e.s));
  const past = list.filter(x => x.e.e < today()).sort((a, b) => b.e.s.localeCompare(a.e.s));
  const opt = x => `<option value="${x.k}">${esc(md(x.e.s))} ${esc(x.e.n.replace(/★.*$/, ""))}</option>`;
  sel.innerHTML = `<optgroup label="進行中與即將登場">${now.map(opt).join("")}</optgroup>` +
    `<optgroup label="過往卡池">${past.map(opt).join("")}</optgroup>`;
  sel.value = ui.event;
}

// ---------- 想要清單 ----------
let catalog = [];
const norm = s => s.normalize("NFKC").toLowerCase();
const sources = id => P.sourcesOf(world, id);
const srcIcons = id => `<span class="srcs">${sources(id).map(s => icon(SOURCE_ICON[s], "sm")).join("")}</span>`;

function renderSuggest(open) {
  const box = $("suggest"), q = norm($("q").value.trim());
  if (!open) { box.hidden = true; $("q").setAttribute("aria-expanded", "false"); return; }
  const hits = catalog.filter(c => !wishlist().includes(c.id))
    .map(c => ({ c, r: !q ? 0 : c.names.some(n => norm(n).startsWith(q)) ? 0 : c.names.some(n => norm(n).includes(q)) ? 1 : 2 }))
    .filter(h => h.r < 2 && (q || sources(h.c.id).length))
    .sort((a, b) => a.r - b.r || a.c.names[0].localeCompare(b.c.names[0], "zh-Hant"));
  const group = (title, arr) => arr.length ? `<div class="grp">${title}（${arr.length}）</div>` +
    arr.slice(0, 40).map(h => `<button data-id="${h.c.id}"><span>${esc(h.c.names[0])}${h.c.rarity === 5 ? "（傳說稀有）" : ""}</span>${srcIcons(h.c.id)}</button>`).join("") : "";
  const yes = hits.filter(h => sources(h.c.id).length), no = hits.filter(h => !sources(h.c.id).length);
  box.innerHTML = group("現在抽得到", yes) + group("現在抽不到", no) || `<div class="grp">找不到符合的角色</div>`;
  box.hidden = false;
  $("q").setAttribute("aria-expanded", "true");
}

function renderChips() {
  $("chips").innerHTML = wishlist().map(id => {
    const has = sources(id).length > 0, off = ui.off.has(id);
    return `<span class="chip ${has ? "" : "out"} ${off ? "off" : ""}">` +
      `<button class="chip-name ${rarityCls({ rarity: D.cats[id]?.rarity, info: D.cats[id] })}" data-toggle="${id}" aria-pressed="${!off}" title="${off ? "這次不算，點一下加回來" : "點一下這次先不算"}">` +
      `${esc(catName(id))}${has ? "" : "<span class=\"small\">・現在抽不到</span>"}</button>` +
      `<button class="x" data-rm="${id}" aria-label="從想要清單移除 ${esc(catName(id))}">×</button></span>`;
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

function renderStages(steps) {
  const head = headOf(steps);
  const items = stagesOf(steps).map(st => {
    const ds = st.steps.flatMap(draws);
    const hits = ds.filter(d => isTarget(d.cat.id));
    const sw = ds.filter(d => d.switched && !d.guaranteed);
    const where = poolName(st.pool) ? `<div class="where">${esc(poolName(st.pool))}</div>` : "";
    return `<li class="step" data-stage="${st.no}">${where}<div class="step-title"><span class="seg-item">${stageChip(st.action, st.steps.length)}</span>` +
      `<span class="mono muted">${ds[0].at} → ${ds.at(-1).after}</span>` +
      `<button class="locate" data-locate="${st.no}" aria-label="在序列標出這一段">序列 ↗</button></div>` +
      (hits.length ? `<div class="hit">拿到 ${hits.map(d => `${esc(d.cat.name)}（${d.at}）`).join("、")}</div>` : "") +
      (sw.length ? `<div class="sw-line">換列 ${sw.map(d => `${d.at}→${d.after}`).join("、")}</div>` : "") +
      `<details><summary>每一抽的角色</summary><ol class="draws">${ds.map(drawRow).join("")}</ol></details></li>`;
  }).join("");
  return { head, items };
}

// 共 N 抽，下面條列用到的資源：用量、剩多少或差多少
function costBlock(c) {
  const rows = [["t", c.t, progress.tickets], ["f", c.food, progress.food], ["p", c.p, progress.plat], ["l", c.l, progress.legend]]
    .filter(([, used]) => used > 0)
    .map(([k, used, have]) => {
      const left = have - used;
      return `<li>${icon(k)}<span class="used">${used}</span>${left >= 0 ? `<span class="left">剩 ${left}</span>` : `<span class="short">差 ${-left}</span>`}</li>`;
    }).join("");
  return `<div class="total">共 ${c.draws} 抽</div><ul class="costs">${rows}</ul>`;
}

function confirmBox(steps) {
  const c = cost(steps);
  const next = glabel(steps.at(-1).next);
  if (ui.confirm !== "plan") return `<button class="primary" data-ask="plan" ${affordable(c) ? "" : "disabled"}>照這個抽完了，存進度</button>`;
  const change = [["t", "tickets", c.t], ["f", "food", c.food], ["p", "plat", c.p], ["l", "legend", c.l]].filter(([, , u]) => u > 0)
    .map(([k, f, u]) => `<li>${icon(k)}<span class="used">${progress[f]} → ${progress[f] - u}</span></li>`).join("");
  return `<div class="confirm"><b>確定存成這樣？</b><div>下一抽 <span class="mono">${progress.position} → ${next}</span></div><ul class="costs">${change}</ul>` +
    `<div class="row"><button class="primary" data-commit="plan" ${busy ? "disabled" : ""}>確定存</button><button class="ghost" data-cancel>取消</button></div></div>`;
}

function hintBox(h) {
  const now = cost(ui.plan.steps);
  const fewer = [];
  if (h.cost.p + h.cost.l < now.p + now.l) fewer.push(`少用 ${now.p + now.l - h.cost.p - h.cost.l} 張白金／傳說券`);
  if (h.cost.draws < now.draws) fewer.push(`少 ${now.draws - h.cost.draws} 抽`);
  const head = headOf(h.plan.steps);
  return `<div class="box hint"><b>等 ${md(h.date)} ${esc(h.opened.join("、"))} 開了再抽，${fewer.join("、")}</b>` +
    `<div class="plan-head">${head}</div>${costBlock(h.cost)}</div>`;
}

function renderPlan() {
  const out = $("plan-out");
  const saved = ui.saved ? `<div class="box">${msgHtml()}</div>` : "";
  if (!ui.plan) { out.innerHTML = saved; return; }
  const p = ui.plan;
  const skipped = p.skipped?.length ? `<p class="note">${esc(p.skipped.map(catName).join("、"))} 現在抽不到，這次先不算。</p>` : "";
  if (p.error) { out.innerHTML = `<div class="box">${esc(p.error)}${skipped}</div>`; return; }
  const { head, items } = renderStages(p.steps);
  out.innerHTML = saved + `<div class="box"><div class="plan-head">${head}</div>${costBlock(cost(p.steps))}${skipped}` +
    `<ol class="steps">${items}</ol><p class="note">抽完下一抽 <span class="mono">${E.labelOf(base + p.index)}</span></p>${confirmBox(p.steps)}</div>` +
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
  ui.route = r.error ? new Map() : routeOf(r.steps);
  // 電腦版序列就在旁邊：算完先讓整條路線亮一次
  ui.focus = desktop.matches ? "all" : null;
  if (ui.route.size) {
    const need = Math.max(...ui.route.keys()) / 2 + 3;
    if (need > ui.seqRows) { ui.seqRows = Math.ceil(need / 20) * 20; if (ui.seqRows > table.rows.length) rebuild(); }
  }
  if (!r.error) ui.hint = P.waitHint(D, progress, today(), g, ui.prio, r, worldOpts());
  renderPlan(); renderSeq();
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
    steps: stagesText(steps), stages: stagesData(steps), got, tickets: c.t, food: c.food, plat: c.p, legend: c.l, via: "找抽法",
    before: snapshot(progress),
  };
  const next = { ...progress, seed: st.seed, last: st.last, position: to, event: ui.event,
    tickets: progress.tickets - c.t, food: progress.food - c.food, plat: progress.plat - c.p, legend: progress.legend - c.l,
    history: [entry, ...(progress.history || [])] };
  renderPlan();
  if (!(await persist(next, `抽卡 ${entry.from} → ${to}`))) return;
  ui.plan = null; ui.hint = null; ui.confirm = null;
  ui.saved = `已存：下一抽 ${to}`;
  rebuild(); renderAll();
}

// ---------- 序列與校正位置 ----------
function renderSeq() {
  const start = table.start;
  const route = ui.plan?.steps ? ui.route : new Map();
  $("seq").innerHTML = table.rows.slice(0, ui.seqRows).map(row => `<div class="seq-row">${row.map(cat => {
    const now = cat === start || cat.rerolled === start;
    const k = E.cellIndex(cat);
    const r = route.get(k);
    const glow = r && (ui.focus === "all" || ui.focus === r.no);
    return `<button class="cell ${rarityCls(cat)} ${now ? "now" : ""} ${isTarget(cat.id) ? "target" : ""} ${ui.calib?.k === k ? "picked" : ""} ${r ? "route" : ""} ${glow ? "glow" : ""}" data-cell="${k}"` +
      (glow ? ` style="animation-delay:${Math.min(r.order, 40) * 25}ms"` : "") + `>` +
      `<span class="mono">${glabel(cat)}${r ? `<span class="stage-no">${r.no}</span>` : ""}</span><span class="nm">${esc(cat.name)}</span>` +
      (cat.rerolled ? `<span class="alt">重複 → ${esc(cat.rerolled.name)}</span>` : "") +
      extraLines(cat, "xl") + "</button>";
  }).join("")}</div>`).join("");
}

// 在序列標出路線的某一段：手機先切到序列頁，再捲到那一段的第一格
function locate(no) {
  ui.focus = no;
  if (!desktop.matches) setTab("seq");
  renderSeq();
  const cell = document.querySelector("#seq .cell.glow");
  cell?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// 校正：把下一抽改到第 k 格（以目前下一抽為 0）。上一抽只影響「這格會不會因重複換列」
function pickCalib(k) {
  if (!Number.isInteger(k) || Math.abs(k) > 2000) return;
  const seed = E.seedAt(progress.seed, k);
  const cand = new Map();
  for (const p of world.pools) {
    // 往回校正時目前的表格沒有那幾格，用新種子另外算一張只看第一格
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
  if (!ui.calib) { out.innerHTML = $("panel-seq").hidden ? "" : msgHtml(); return; }
  const c = ui.calib;
  out.innerHTML = `<div class="confirm"><b>下一抽改成 <span class="mono">${c.label}</span>？</b>` +
    (c.cand.length ? `<div class="small">上一抽拿到誰？</div>` +
      [...c.cand.map(([id, name]) => `<label class="radio"><input type="radio" name="calib-last" value="${id}"> ${esc(name)}（${esc(c.label)} 會重複換列）</label>`),
        `<label class="radio"><input type="radio" name="calib-last" value="0" checked> 都不是</label>`].join("") : "") +
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
  ui.saved = `已校正：下一抽 ${c.label}`;
  rebuild(); renderAll();
}

// ---------- 抽卡紀錄與復原 ----------
function logStages(h) {
  if (h.stages) return `<div class="plan-head" style="font-size:15px">${h.stages.map((s, i) =>
    `${i ? '<span class="arrow">→</span>' : ""}<span class="seg-item">${stageChip(s.a, s.n)}</span>`).join("")}</div>`;
  return h.steps ? `<div class="small">${esc(h.steps)}</div>` : "";
}

function renderLog() {
  const list = progress.history || [];
  const top = list[0];
  const undo = top?.before ? (ui.undo
    ? `<div class="confirm"><b>復原最近這次存檔？</b><div>下一抽 <span class="mono">${progress.position} → ${top.before.position}</span></div>` +
      `<div class="row"><button class="primary" id="undo-ok" ${busy ? "disabled" : ""}>確定復原</button><button class="ghost" id="undo-cancel">取消</button></div></div>`
    : `<button class="ghost" id="undo-ask">復原最近這次存檔</button>`) : "";
  $("log").innerHTML = ($("panel-log").hidden ? "" : msgHtml()) + undo + (list.length ? `<ol class="steps">${list.map(h => `<li class="step">` +
    `<div class="step-title"><span class="mono">${esc(h.from)} → ${esc(h.to)}</span><span class="muted small">${esc(h.type || "抽卡")}・${esc(h.time)}</span></div>` +
    logStages(h) +
    (h.got?.length ? `<div class="hit small">${esc(h.got.join("、"))}</div>` : "") +
    (h.type === "校正" ? "" : `<div class="log-cost">${[["t", h.tickets], ["f", h.food], ["p", h.plat], ["l", h.legend]]
      .filter(([, v]) => v).map(([k, v]) => `<span class="money">${icon(k, "sm")}${v}</span>`).join("")}</div>`) +
    `</li>`).join("")}</ol>` : `<p class="note">還沒有紀錄。</p>`);
}

async function commitUndo() {
  const [top, ...rest] = progress.history || [];
  if (busy || !top?.before) return;
  const next = { ...progress, ...top.before, history: rest };
  if (!(await persist(next, `復原：${top.from} → ${top.to}`))) return;
  ui.undo = false; ui.plan = null; ui.hint = null; ui.event = next.event && D.events[next.event] ? next.event : ui.event;
  ui.saved = `已復原：下一抽 ${top.before.position}`;
  rebuild(); renderAll();
}

function renderAll() { renderBar(); renderNow(); renderPools(); renderChips(); renderPlan(); renderSeq(); renderCalib(); renderLog(); }

// ---------- 分頁：手機一次一頁；電腦左邊固定找抽法、右邊切換序列／紀錄 ----------
function applyTabs() {
  const wide = desktop.matches;
  const show = name => wide ? (name === "plan" || name === ui.side) : name === ui.tab;
  $("panel-plan").hidden = !show("plan");
  $("panel-seq").hidden = !show("seq");
  $("panel-log").hidden = !show("log");
  $("col-side").hidden = !(show("seq") || show("log"));
  for (const b of document.querySelectorAll("#tabbar [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab));
  for (const b of document.querySelectorAll(".side-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === ui.side));
}
function setTab(name) {
  ui.tab = name;
  if (name !== "plan") ui.side = name;
  ui.saved = "";
  applyTabs();
  renderLog(); renderCalib();
  if (!desktop.matches) window.scrollTo(0, 0);
}

// ---------- 連線 ----------
function showSetup(message, canCancel) {
  $("loading").hidden = true;
  $("setup").hidden = false;
  $("setup-err").hidden = !message;
  $("setup-err").textContent = message || "";
  $("setup-cancel").hidden = !canCancel;
}

function showMain() {
  $("loading").hidden = true;
  $("bar").hidden = false;
  $("tabbar").hidden = false;
  applyTabs();
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
    showMain();
    renderAll();
  } catch (err) {
    token = prev;
    showSetup(err instanceof GH.AuthError ? err.message : `讀不到進度：${err.message}`, !!progress);
    if (progress) showMain();
  }
}

// ---------- 事件 ----------
function bind() {
  for (const [k, src] of Object.entries(ICON)) for (const img of document.querySelectorAll(`.ic-${k}`)) img.src = src;
  desktop.addEventListener("change", applyTabs);
  // 電腦版：游標移到路線的某一段，旁邊序列裡那幾格就亮起來
  document.addEventListener("mouseover", e => {
    if (!desktop.matches || !ui.plan?.steps) return;
    const st = e.target.closest("#plan-out .step[data-stage]");
    if (st && +st.dataset.stage !== ui.focus) { ui.focus = +st.dataset.stage; renderSeq(); }
  });

  $("pool").onchange = async e => {
    const prev = ui.event;
    ui.event = e.target.value; ui.plan = null; ui.hint = null; ui.saved = ""; ui.calib = null;
    rebuild(); renderAll();
    if (!(await persist({ ...progress, event: ui.event }, "切換卡池"))) { ui.event = prev; rebuild(); renderAll(); }
  };
  $("wallet-btn").onclick = () => openWallet($("wallet-edit").hidden);
  $("wallet-save").onclick = saveWallet;
  $("wallet-cancel").onclick = () => openWallet(false);
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
    // 資源編輯框打開時，點框外任何地方就取消
    if (!$("wallet-edit").hidden && !e.target.closest("#wallet-edit, #wallet-btn")) openWallet(false);
    if (!t) return;
    if (t.dataset.tab) setTab(t.dataset.tab);
    else if (t.dataset.locate) locate(+t.dataset.locate);
    else if (t.dataset.id) { $("q").value = ""; renderSuggest(false); setWishlist([...wishlist(), +t.dataset.id], `想要清單加入 ${catName(+t.dataset.id)}`); }
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
    D = await (await fetch("../data/bc-tw.json", { cache: "no-cache" })).json();
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
