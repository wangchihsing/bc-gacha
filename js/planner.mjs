// 網站與每日通知共用的規劃邏輯：決定哪些卡池能抽、建表格、找最省抽法
import * as E from "./engine.mjs";

export const FOOD_PER_ELEVEN = 1500;
export const MAX_NODES = 1500000;

// 某天開著的一般卡池；同一個轉蛋（同 id）同時有好幾段排程時只留最新開始的那段
export function openPools(D, date) {
  const byGacha = new Map();
  for (const [key, e] of Object.entries(D.events)) {
    if (e.k || e.s > date || e.e < date) continue;
    const cur = byGacha.get(e.id);
    if (!cur || e.s > cur.e.s) byGacha.set(e.id, { key, e });
  }
  return [...byGacha.values()].sort((a, b) => b.e.s.localeCompare(a.e.s));
}

// 某天的白金或傳說轉蛋：用最新開始的那版
export function extraEvent(D, kind, date) {
  return Object.entries(D.events).filter(([, e]) => e.k === kind && e.s <= date && e.e >= date)
    .sort((a, b) => b[1].s.localeCompare(a[1].s))[0]?.[0];
}

export function shortName(e) {
  const m = /「([^」]+)」/.exec(e.n);
  return m ? `「${m[1]}」池` : e.n.replace(/★.*$/, "").slice(0, 10) + "…池";
}

// 某天、某個進度下所有能抽的池與表格
// first：排第一的一般卡池（網站選單選的那池），換池次數一樣時優先用它
export function buildWorld(D, progress, date, { count = 720, first } = {}) {
  const st = { seed: progress.seed, last: progress.last, count };
  const pools = openPools(D, date)
    .sort((a, b) => (b.key === first) - (a.key === first))
    .map(({ key, e }) => {
      const pool = E.makePool(D, key);
      return { key, e, name: shortName(e), pool, rows: E.buildTable(pool, st).rows, guaranteedRolls: pool.guaranteedRolls };
    });
  const extras = [{ action: "plat", label: "白金" }, { action: "legend", label: "傳說" }].map(x => {
    const key = extraEvent(D, x.action, date);
    if (!key) return null;
    const pool = E.makePool(D, key);
    return { ...x, key, pool, rows: E.buildTable(pool, st).rows };
  }).filter(Boolean);
  return { date, pools, extras };
}

const hasCat = (pool, id) => (pool.slots[4] || []).includes(id) || (pool.slots[5] || []).includes(id);

// 某隻角色在哪幾種池抽得到：["一般", "白金", "傳說"] 的子集
export function sourcesOf(world, id) {
  return [...(world.pools.some(p => hasCat(p.pool, id)) ? ["一般"] : []),
    ...world.extras.filter(x => hasCat(x.pool, id)).map(x => x.label)];
}

export function costOf(steps) {
  const n = a => steps.filter(s => s.action === a).length;
  const t = n("ticket"), e = n("eleven");
  return { t, e, p: n("plat"), l: n("legend"), food: e * FOOD_PER_ELEVEN, draws: t + 11 * e };
}

export const affordable = (c, progress) =>
  c.t <= progress.tickets && c.food <= progress.food && c.p <= (progress.plat ?? 0) && c.l <= (progress.legend ?? 0);

// 最省抽法：先不管餘額找最好的；餘額不夠才在餘額內另外找
// 回傳 { steps, index, last } 或 { error }
export function bestPlan(world, progress, goals, priority = "draws") {
  const pools = world.pools.map(p => ({ key: p.key, rows: p.rows, guaranteedRolls: p.guaranteedRolls }));
  const run = (limits, opts) => E.findPlanMulti({ index: 0, last: progress.last }, goals, limits, priority, pools, world.extras, opts);
  const n = goals.length;
  let r = run({ tickets: 300, eleven: 30, plat: n, legend: n }, { relaxed: true, maxNodes: MAX_NODES });
  if (r?.tooBig) return { error: "目標太多，算不出來；先把這次不急的角色關掉再找。" };
  if (!r) return { error: "就算金券 300 張、11 連 30 次，再加上白金券、傳說券，也抽不到全部目標。" };
  if (!affordable(costOf(r.steps), progress)) {
    const elevenCap = Math.floor(progress.food / FOOD_PER_ELEVEN);
    const within = run({ tickets: progress.tickets, eleven: elevenCap, plat: Math.min(progress.plat ?? 0, n), legend: Math.min(progress.legend ?? 0, n) },
      { maxNodes: 300000 });
    if (within && !within.tooBig) r = within;
  }
  return r;
}

// 比較用的分數：白金＋傳說券用量優先，再看總抽數
export const scoreOf = c => [c.p + c.l, c.l, c.draws];
const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// 即將開的卡池：未來 21 天內每個有新池開的日子，假設那天才抽，算一次最省抽法
// 只有明顯比較省（少用白金／傳說券，或少 10 抽以上）才回傳建議
export function waitHint(D, progress, today, goals, priority, current, opts = {}) {
  if (current.error) return null;
  const now = costOf(current.steps);
  const limit = new Date(Date.parse(today) + 21 * 86400e3).toISOString().slice(0, 10);
  const dates = [...new Set(Object.values(D.events).filter(e => !e.k && e.s > today && e.s <= limit).map(e => e.s))].sort();
  let best = null;
  for (const date of dates) {
    const world = buildWorld(D, progress, date, opts);
    const r = bestPlan(world, progress, goals, priority);
    if (r.error) continue;
    const c = costOf(r.steps);
    const clearly = c.p + c.l < now.p + now.l || (c.p + c.l === now.p + now.l && c.l <= now.l && c.draws <= now.draws - 10);
    if (clearly && (!best || better(scoreOf(c), scoreOf(best.cost)))) {
      const opened = Object.values(D.events).filter(e => !e.k && e.s === date).map(shortName);
      best = { date, opened, plan: r, cost: c, world };
    }
  }
  return best;
}
