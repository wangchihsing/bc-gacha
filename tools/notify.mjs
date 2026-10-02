// 想要清單通知：在私人進度儲存庫的 GitHub Actions 每天跑
// 讀 progress.json 的想要清單，逐隻算最省抽法；用現有資源抽得到、而上次還抽不到的，推播到 ntfy
// 同一隻只通知一次，要先變回抽不到、之後又抽得到才會再通知
// 環境變數：NTFY_TOPIC、SITE（網站程式所在資料夾）；DRY=1 只印不推播
// TEST_IDS=角色編號,角色編號：用這幾隻代替想要清單、忽略舊狀態、標題標（測試）、不寫回狀態檔
import fs from "node:fs";
import path from "node:path";

const SITE = process.env.SITE || "site";
const P = await import(path.resolve(SITE, "js/planner.mjs"));
const D = JSON.parse(fs.readFileSync(path.resolve(SITE, "data/bc-tw.json")));
const progress = JSON.parse(fs.readFileSync("progress.json"));
const STATE = "notify-state.json";
const TEST_IDS = (process.env.TEST_IDS || "").split(",").filter(Boolean).map(Number);
const state = !TEST_IDS.length && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};

progress.plat ??= 0; progress.legend ??= 0;
const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
const world = P.buildWorld(D, progress, date, { count: 720, first: progress.event });
const name = id => D.cats[id]?.name?.[0] ?? String(id);

const ready = [];
const nextState = {};
const wishlist = TEST_IDS.length ? TEST_IDS : progress.wishlist || [];
for (const id of wishlist) {
  let afford = false;
  if (P.sourcesOf(world, id).length) {
    const r = P.bestPlan(world, progress, [id]);
    afford = !r.error && P.affordable(P.costOf(r.steps), progress);
  }
  if (afford && !state[id]?.afford) ready.push(name(id));
  nextState[id] = { afford, checked: date };
}

if (!TEST_IDS.length) fs.writeFileSync(STATE, JSON.stringify(nextState, null, 2) + "\n");
console.log(`${date}：清單 ${wishlist.length} 隻，要通知 ${ready.length} 隻`);

if (ready.length) {
  const msg = {
    topic: process.env.NTFY_TOPIC,
    title: TEST_IDS.length ? "貓戰（測試）" : "貓戰",
    message: `${ready.join("、")} 可以抽了`,
    click: "https://wangchihsing.github.io/bc-gacha/",
  };
  if (process.env.DRY) {
    console.log(msg.title, "｜", msg.message);
  } else {
    if (!msg.topic) throw new Error("沒有設定 NTFY_TOPIC");
    const res = await fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify(msg) });
    if (!res.ok) throw new Error(`推播失敗：${res.status} ${await res.text()}`);
    console.log("已推播：", msg.message);
  }
}
