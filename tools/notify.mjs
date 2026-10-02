// 想要清單通知：在私人進度儲存庫的 GitHub Actions 每天跑
// 讀 progress.json 的想要清單，逐隻算最省抽法；符合條件就開一則 Issue 推播
// 條件：① 用現有資源就抽得到（之前抽不到）② 同一個位置下，最省抽法比上次通知時少 20 抽以上
// 環境變數：GH_TOKEN、REPO（owner/repo）、SITE（網站程式所在資料夾）；DRY=1 只印不開 Issue
// TEST_IDS=角色編號,角色編號：用這幾隻代替想要清單、忽略舊狀態、標題標【測試】、不寫回狀態檔
import fs from "node:fs";
import path from "node:path";

const SITE = process.env.SITE || "site";
const E = await import(path.resolve(SITE, "js/engine.mjs"));
const P = await import(path.resolve(SITE, "js/planner.mjs"));
const D = JSON.parse(fs.readFileSync(path.resolve(SITE, "data/bc-tw.json")));
const progress = JSON.parse(fs.readFileSync("progress.json"));
const STATE = "notify-state.json";
const TEST_IDS = (process.env.TEST_IDS || "").split(",").filter(Boolean).map(Number);
const state = !TEST_IDS.length && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const DROP = 20;

progress.plat ??= 0; progress.legend ??= 0;
const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
const world = P.buildWorld(D, progress, date, { count: 720, first: progress.event });
const base = E.indexOf(progress.position);
const label = cat => E.labelOf(base + E.cellIndex(cat));
const name = id => D.cats[id]?.name?.[0] ?? String(id);
const ACTION = { ticket: "金券", eleven: "11連", plat: "白金券", legend: "傳說券" };

function stagesText(steps) {
  const out = [];
  for (const s of steps) {
    const prev = out.at(-1);
    if (prev && s.action !== "eleven" && prev.action === s.action && prev.pool === s.pool) { prev.n++; continue; }
    out.push({ action: s.action, pool: s.pool, n: 1, from: label(s.cats[0]) });
  }
  return out.map(s => `${s.action === "eleven" ? "11連" : `${ACTION[s.action]}×${s.n}`}` +
    `${world.pools.find(p => p.key === s.pool)?.name ? "@" + world.pools.find(p => p.key === s.pool).name : ""}（從 ${s.from}）`).join(" → ");
}

const news = [];
const nextState = {};
const wishlist = TEST_IDS.length ? TEST_IDS : progress.wishlist || [];
for (const id of wishlist) {
  if (!P.sourcesOf(world, id).length) { nextState[id] = { ...state[id], unavailable: true }; continue; }
  const r = P.bestPlan(world, progress, [id]);
  if (r.error) { nextState[id] = state[id] || {}; continue; }
  const c = P.costOf(r.steps);
  const afford = P.affordable(c, progress);
  const prev = state[id];
  const samePos = prev?.position === progress.position;
  const reasons = [];
  if (afford && !prev?.afford) reasons.push("用你現在的資源就抽得到了");
  if (samePos && prev.base != null && prev.base - c.draws >= DROP) reasons.push(`最省抽法比上次少 ${prev.base - c.draws} 抽`);
  // 位置變了（你抽過了）就重設比較基準，不把「自己抽掉的」當成變好抽
  const baseDraws = !samePos || reasons.length || prev.base == null ? c.draws : prev.base;
  nextState[id] = { afford, base: baseDraws, position: progress.position, draws: c.draws, checked: date };
  if (reasons.length) {
    const parts = [c.t && `金券 ${c.t} 張`, c.food && `罐頭 ${c.food} 個`, c.p && `白金券 ${c.p} 張`, c.l && `傳說券 ${c.l} 張`].filter(Boolean);
    news.push(`- **${name(id)}**：${reasons.join("；")}。\n  抽法：${stagesText(r.steps)}\n  共 ${c.draws} 抽（${parts.join("、")}），抽完下一抽 ${E.labelOf(base + r.index)}`);
  }
}

if (!TEST_IDS.length) fs.writeFileSync(STATE, JSON.stringify(nextState, null, 2) + "\n");
console.log(`${date}：清單 ${wishlist.length} 隻，要通知 ${news.length} 隻`);

if (news.length) {
  const test = TEST_IDS.length ? "【測試】" : "";
  const title = `${test}貓戰：${news.length} 隻想要的角色變好抽了（${date}）`;
  const body = `目前下一抽 ${progress.position}。\n\n${news.join("\n")}\n\n到網站看完整路線：https://wangchihsing.github.io/bc-gacha/\n\n@wangchihsing`;
  if (process.env.DRY) {
    console.log(title + "\n" + body);
  } else {
    const res = await fetch(`https://api.github.com/repos/${process.env.REPO}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) throw new Error(`開 Issue 失敗：${res.status} ${await res.text()}`);
    console.log("已開 Issue：", (await res.json()).html_url);
  }
}
