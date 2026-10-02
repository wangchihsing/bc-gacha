// 貓戰抽卡計算核心：移植自 godfat/battle-cats-rolls（Apache License 2.0）
// 來源：https://gitlab.com/godfat/battle-cats-rolls lib/battle-cats-rolls/gacha.rb、gacha_pool.rb、route.rb
// 移植時保持原程式的運算順序，表格與 bc.godfat.org 逐格一致。

export const Rare = 2, Supa = 3, Uber = 4, Legend = 5;
const Base = 10000;
const MaxSeed = 2 ** 32;

export function advanceSeed(s) {
  s = (s ^ (s << 13)) >>> 0;
  s = (s ^ (s >>> 17)) >>> 0;
  s = (s ^ (s << 15)) >>> 0;
  return s;
}

// 往回推一格，godfat gacha.rb 的 retreat_seed
export function retreatSeed(s) {
  const shl = (x, b) => (x ^ (x << b)) >>> 0;
  s = shl(s, 15);
  s = shl(s, 30);
  s = (s ^ (s >>> 17)) >>> 0;
  s = shl(s, 13);
  s = shl(s, 26);
  return s;
}

// 從某個狀態的種子往前（k>0）或往回（k<0）移 k 格後的種子
export function seedAt(seed, k) {
  for (let i = 0; i < k; i++) seed = advanceSeed(seed);
  for (let i = 0; i > k; i--) seed = retreatSeed(seed);
  return seed;
}

export function normalizeSeed(n) {
  return Math.abs(Math.trunc(n)) % MaxSeed;
}

// data 為 bc-tw.json：{ cats, gacha, events }
export function makePool(data, eventKey) {
  const event = data.events[eventKey];
  if (!event) throw new Error("找不到卡池 " + eventKey);
  const gachaCats = data.gacha[event.id]?.cats || [];
  const slots = { [Rare]: [], [Supa]: [], [Uber]: [], [Legend]: [] };
  for (const id of gachaCats) {
    const rarity = data.cats[id]?.rarity;
    if (rarity == null) { // 原程式：有一隻查不到就整池視為空
      for (const k in slots) slots[k] = [];
      break;
    }
    (slots[rarity] ||= []).push(id);
  }
  const rare = event.rare, supa = event.supa, uber = event.uber;
  return {
    event, slots, cats: data.cats,
    rare, supa, uber, legend: Base - rare - supa - uber,
    guaranteedRolls: event.guaranteed ? 11 : event.step_up ? 15 : 0,
  };
}

class Cat {
  constructor(f) { Object.assign(this, f); }
  get name() { return this.info?.name?.[0] ?? String(this.id); }
  get number() {
    const t = this.track == null ? "+" : String.fromCharCode(65 + this.track);
    return `${this.sequence}${t}${this.extraLabel || ""}`;
  }
  duped(rhs) {
    return !!rhs && this.rarity === Rare && this.id === rhs.id && this.id > 0;
  }
}

class Gacha {
  constructor(pool, seed) {
    this.pool = pool;
    this.seed = seed;
    this.lastBoth = [];
    this.lastRoll = null;
    this.advance();
  }
  advance() { this.seed = advanceSeed(this.seed); }
  rollSeed() { const s = this.seed; this.advance(); return s; }

  rollBoth(sequence) {
    const aSeed = this.rollSeed();
    const bSeed = this.seed;
    const a = this.rollCat(aSeed, () => this.rollSeed());
    const b = this.rollCat(bSeed);
    a.track = 0; b.track = 1;
    a.sequence = b.sequence = sequence;
    this.fillCatLinks(a, this.lastBoth[0]);
    this.fillCatLinks(b, this.lastBoth[1]);
    this.lastBoth = [a, b];
    return this.lastBoth;
  }

  rollCat(raritySeed, slotSeedFn) {
    const score = raritySeed % Base;
    const rarity = this.digRarity(score);
    const slotSeed = slotSeedFn ? slotSeedFn() : this.seed;
    const cat = this.newCat(rarity, slotSeed);
    cat.raritySeed = raritySeed;
    cat.score = score;
    return cat;
  }

  digRarity(score) {
    const { rare, supa, uber } = this.pool;
    if (score < rare) return Rare;
    if (score < rare + supa) return Supa;
    if (score < rare + supa + uber) return Uber;
    return Legend;
  }

  newCat(rarity, slotSeed, extra = {}) {
    const slots = this.pool.slots[rarity] || [];
    let slot = null, id = -1, info = { name: ["N/A"] };
    if (slots.length) {
      slot = slotSeed % slots.length;
      id = slots[slot];
      info = this.pool.cats[id];
    }
    return new Cat({ id, info, rarity, slotSeed, slot, ...extra });
  }

  rerollCat(cat) {
    const slots = [...this.pool.slots[cat.rarity]];
    const dupes = slots.filter(x => x === cat.id).length;
    let nextSeed = cat.slotSeed, slot = cat.slot, id = null, steps = null;
    for (let i = 1; i <= dupes; i++) {
      nextSeed = advanceSeed(nextSeed);
      slots.splice(slot, 1);
      slot = nextSeed % slots.length;
      id = slots[slot];
      if (id !== cat.id) { steps = i; break; }
    }
    return new Cat({
      id, info: this.pool.cats[id], rarity: cat.rarity, score: cat.score,
      slotSeed: nextSeed, slot, sequence: cat.sequence, track: cat.track,
      steps, extraLabel: `${cat.extraLabel || ""}R`,
    });
  }

  fillCatLinks(cat, lastCat) {
    if (cat.duped(lastCat)) {
      lastCat.next = cat.rerolled ||= this.rerollCat(cat);
    } else if (lastCat) {
      lastCat.next = cat;
    }
  }

  finishRerolledLinks(cats) {
    cats.forEach((row, index) => row.forEach((c, track) => {
      const r = c.rerolled;
      if (!r || r.steps == null) return;
      const nextIndex = index + Math.floor((track + r.steps) / 2) + 1;
      const nextTrack = ((track + r.steps - 1) ^ 1) & 1;
      const nextCat = cats[nextIndex]?.[nextTrack];
      if (nextCat) this.fillCatLinks(nextCat, r);
    }));
  }

  finishGuaranteed(cats, g) {
    cats.forEach(row => row.forEach(c => {
      this.fillGuaranteed(cats, g, c);
      if (c.rerolled) this.fillGuaranteed(cats, g, c.rerolled);
    }));
  }

  fillGuaranteed(cats, g, cat) {
    let last = cat;
    for (let i = 0; i < g - 1; i++) { last = last.next; if (!last) return; }
    const nextCat = cats[last.sequence - (last.track ^ 1)]?.[last.track ^ 1];
    if (!nextCat) return;
    const slotSeed = cats[last.sequence - 1][last.track].raritySeed;
    cat.guaranteed = this.newCat(Uber, slotSeed, {
      sequence: cat.sequence, track: cat.track, next: nextCat,
      extraLabel: `${cat.extraLabel || ""}G`,
    });
  }
}

// 對應 route.rb 的 prepare_tracks：算出 count 列的 A/B 表格
// 回傳 { rows, start }，start 是下一抽實際會落在的格子（含換列後的 R 格）
export function buildTable(pool, { seed, last = 0, count = 100 }) {
  const gacha = new Gacha(pool, normalizeSeed(seed));
  let lastRoll = null;
  if (last) {
    lastRoll = new Cat({ id: last });
    gacha.lastRoll = lastRoll;
    gacha.lastBoth = [lastRoll, null];
  }
  const rows = [];
  for (let seq = 1; seq <= count; seq++) rows.push(gacha.rollBoth(seq));
  gacha.finishRerolledLinks(rows);
  if (last) gacha.fillCatLinks(rows[0][0], lastRoll);
  if (pool.guaranteedRolls > 0) gacha.finishGuaranteed(rows, pool.guaranteedRolls);
  const start = lastRoll ? lastRoll.next : rows[0][0];
  return { rows, start };
}

// 實際抽完一隻後的續算狀態（等同 godfat 點貓名後的網址）
export function stateAfter(cat) {
  return { seed: cat.slotSeed, last: cat.id };
}

// 從某格開始照步驟抽。steps 例：["single","single","guaranteed"]
// 回傳每步抽到的角色與最後的下一抽格子；格子不夠時回傳 null
export function walk(startCat, steps, guaranteedRolls) {
  let pos = startCat;
  const result = [];
  for (const step of steps) {
    if (!pos) return null;
    if (step === "single") {
      result.push({ step, cats: [pos] });
      pos = pos.next;
    } else if (step === "guaranteed") {
      const g = pos.guaranteed;
      if (!g) return null;
      const cats = [];
      let c = pos;
      for (let i = 0; i < guaranteedRolls - 1; i++) { cats.push(c); c = c.next; }
      cats.push(g);
      result.push({ step, cats });
      pos = g.next;
    } else throw new Error("未知步驟 " + step);
  }
  const lastCat = result.at(-1)?.cats.at(-1);
  return { result, next: pos, state: lastCat ? stateAfter(lastCat) : null };
}

// 依格號（如 155B、32BR、156AG）找格子
export function cellsOf(rows) {
  const map = new Map();
  for (const row of rows) for (const c of row) {
    for (const x of [c, c.guaranteed, c.rerolled, c.rerolled?.guaranteed]) if (x) map.set(x.number, x);
  }
  return map;
}

// 找抽法：在多個一般卡池裡用金券單抽、11 連抽，加上白金券、傳說券單抽，找出抽到全部目標的路線
// 所有卡池共用同一條序列，狀態只看「第幾格」與「上一抽是哪隻貓」，所以路線中途可以換池：
// 每個池在同一格出的稀有貓不同，重複換列的機會也不同
// start：{ index, last }（index 以表格 1A=0 起算）
// pools：[{ key, rows, guaranteedRolls }]；extras：[{ action: "plat" | "legend", rows }]
// limits: { tickets, eleven, plat, legend }；priority: "draws" | "tickets" | "food"
// 排序先比白金券＋傳說券用量（同樣多時少用傳說券），再依 priority
// 回傳 { steps: [{ action, pool, cats, next }], index, last, counts } 或 null
const COUNT_KEYS = { ticket: "tickets", eleven: "eleven", plat: "plat", legend: "legend" };

// 某池在某格、上一抽是 last 時，這一抽實際拿到的貓（重複稀有就是換列後的那隻）
export function catAt(rows, index, last) {
  const c = rows[index >> 1]?.[index & 1];
  if (!c) return null;
  return c.duped({ id: last }) ? c.rerolled : c;
}

// opts.relaxed：不在乎資源上限時用，每個狀態只留排序最好的一條路，快很多
// opts.maxNodes：搜尋量上限，超過回傳 { tooBig: true }
export function findPlanMulti(start, goalIds, limits, priority, pools, extras = [], opts = {}) {
  const all = (1 << goalIds.length) - 1;
  const bit = id => goalIds.reduce((b, g, i) => b | (g === id ? 1 << i : 0), 0);
  const lim = k => limits[k] ?? 0;
  const rank = c => {
    const rare = c.plat + c.legend, draws = c.tickets + 11 * c.eleven;
    if (priority === "tickets") return [rare, c.legend, c.eleven, c.tickets, draws];
    if (priority === "food") return [rare, c.legend, c.tickets, c.eleven, draws];
    return [rare, c.legend, draws, c.eleven, c.tickets];
  };
  const cmp = (a, b) => {
    const x = a.rank, y = b.rank;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.order - b.order;
  };
  const keys = ["tickets", "eleven", "plat", "legend"];
  const lexLe = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return true; };
  const le = opts.relaxed ? (a, b) => lexLe(rank(a), rank(b)) : (a, b) => keys.every(k => a[k] <= b[k]);
  const heap = [], seen = new Map();
  let order = 0;
  // 上一抽不是稀有貓就不可能造成重複換列，視為同一個狀態，搜尋量少很多
  const rareIds = new Set(pools.flatMap(p => p.rows.flat().filter(c => c.rarity === Rare).map(c => c.id)));
  const push = n => {
    if (keys.some(k => n.c[k] > lim(k))) return;
    const key = n.index + "/" + (rareIds.has(n.last) ? n.last : 0) + "/" + n.mask;
    let peers = seen.get(key) || [];
    if (peers.some(p => le(p.c, n.c))) return;
    for (const p of peers) if (le(n.c, p.c)) p.alive = false;
    peers = peers.filter(p => p.alive);
    n.alive = true; n.order = order++; n.rank = rank(n.c);
    peers.push(n); seen.set(key, peers);
    heap.push(n);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (cmp(heap[p], heap[i]) <= 0) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0;;) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && cmp(heap[c + 1], heap[c]) < 0) c++;
        if (cmp(heap[i], heap[c]) <= 0) break;
        [heap[i], heap[c]] = [heap[c], heap[i]]; i = c;
      }
    }
    return top;
  };
  const add = (c, action) => ({ ...c, [COUNT_KEYS[action]]: c[COUNT_KEYS[action]] + 1 });
  const go = (n, step) => {
    const lastCat = step.cats.at(-1);
    push({ index: cellIndex(step.next), last: lastCat.id,
      mask: step.cats.reduce((m, x) => m | bit(x.id), n.mask),
      c: add(n.c, step.action), prev: n, step });
  };
  push({ index: start.index, last: start.last, mask: 0, c: { tickets: 0, eleven: 0, plat: 0, legend: 0 }, prev: null });
  let pops = 0;
  while (heap.length) {
    const n = pop();
    if (!n.alive) continue;
    if (opts.maxNodes && ++pops > opts.maxNodes) return { tooBig: true };
    if (n.mask === all) {
      const steps = [];
      for (let x = n; x.prev; x = x.prev) steps.unshift(x.step);
      return { steps: tidyPools(steps, start, pools, goalIds), index: n.index, last: n.last, counts: n.c };
    }
    for (const p of pools) {
      const cat = catAt(p.rows, n.index, n.last);
      if (!cat) continue;
      if (cat.next) go(n, { action: "ticket", pool: p.key, cats: [cat], next: cat.next });
      const e = elevenFrom(cat, p.guaranteedRolls);
      if (e) go(n, { ...e, pool: p.key });
    }
    for (const x of extras) {
      const got = x.rows[n.index >> 1]?.[n.index & 1];
      if (got?.next) go(n, { action: x.action, pool: x.action, cats: [got], next: got.next });
    }
  }
  return null;
}

// 同一步換到別的池抽，只要拿到的目標一樣、抽完停在同一格、對之後的重複換列也沒影響，就算等價；
// 從等價的選法裡挑換池次數最少的組合（同樣少就優先排在前面的池）
function tidyPools(steps, start, pools, goalIds) {
  const goalsOf = st => st.cats.filter(c => goalIds.includes(c.id)).map(c => c.id).sort().join();
  // 抽完停在同一格，而且不管上一抽是哪隻，每個池在那一格拿到的貓都一樣，之後的路線就完全不受影響
  const sameAfter = (a, b) => {
    const i = cellIndex(a.next);
    if (i !== cellIndex(b.next)) return false;
    const la = a.cats.at(-1).id, lb = b.cats.at(-1).id;
    return la === lb || pools.every(p => catAt(p.rows, i, la) === catAt(p.rows, i, lb));
  };
  const same = (a, b) => a.cats.length === b.cats.length && goalsOf(a) === goalsOf(b) && sameAfter(a, b);
  let index = start.index, last = start.last;
  const options = steps.map(step => {
    let opts = [step];
    if (step.action === "ticket" || step.action === "eleven") {
      opts = pools.map(p => {
        const cat = catAt(p.rows, index, last);
        if (!cat) return null;
        const alt = step.action === "ticket" ? (cat.next && { action: "ticket", pool: p.key, cats: [cat], next: cat.next })
          : (e => e && { ...e, pool: p.key })(elevenFrom(cat, p.guaranteedRolls));
        return alt && same(alt, step) ? alt : null;
      }).filter(Boolean);
    }
    index = cellIndex(step.next); last = step.cats.at(-1).id;
    return opts;
  });
  // 動態規劃：best[i][j] = 走到第 i 步、第 i 步用 options[i][j] 時最少換池次數
  const isPool = o => o.action === "ticket" || o.action === "eleven";
  let best = options[0].map(() => ({ cost: 0, path: [] }));
  best = best.map((b, j) => ({ cost: 0, path: [options[0][j]] }));
  for (let i = 1; i < options.length; i++) {
    best = options[i].map(o => {
      let pick = null;
      best.forEach(b => {
        const prevPool = [...b.path].reverse().find(isPool)?.pool;
        const cost = b.cost + (isPool(o) && prevPool && prevPool !== o.pool ? 1 : 0);
        if (!pick || cost < pick.cost) pick = { cost, path: [...b.path, o] };
      });
      return pick;
    });
  }
  return best.reduce((a, b) => (b.cost < a.cost ? b : a)).path;
}

// 單一卡池版（舊介面）：從某格開始找
export function findPlan(startCat, goalIds, limits, priority, guaranteedRolls, rows, extras = []) {
  return findPlanMulti({ index: cellIndex(startCat), last: 0 }, goalIds, limits, priority,
    [{ key: "main", rows, guaranteedRolls }], extras);
}

// 從某格開 11 連；格子不夠回傳 null
export function elevenFrom(cat, guaranteedRolls) {
  const g = guaranteedRolls === 11 && cat.guaranteed;
  const n = g ? 10 : 11, cats = [];
  let c = cat;
  for (let i = 0; i < n && c; i++) { cats.push(c); c = c.next; }
  if (cats.length < n) return null;
  if (g) { cats.push(cat.guaranteed); c = cat.guaranteed.next; }
  return c ? { action: "eleven", cats, next: c } : null;
}

// 從一般池的某格改抽白金或傳說：拿到該池同一格，下一抽回到一般池同列往下一格
// 白金、傳說只出超激以上，不會觸發重複稀有換列，所以下一格一定是原表的那格
export function extraFrom(cat, extraRows, rows, action) {
  const i = cellIndex(cat);
  const got = extraRows[i >> 1]?.[i & 1];
  const next = rows[(i + 2) >> 1]?.[(i + 2) & 1];
  return got && next ? { action, cats: [got], next } : null;
}

// 格號換算：1A=0、1B=1、2A=2…
export function indexOf(label) {
  const m = /^(\d+)([AB])$/.exec(label);
  if (!m) throw new Error("格號格式錯誤：" + label);
  return (m[1] - 1) * 2 + (m[2] === "B" ? 1 : 0);
}
export function labelOf(index) {
  return Math.floor(index / 2) + 1 + (index % 2 ? "B" : "A");
}
export function cellIndex(cat) {
  return (cat.sequence - 1) * 2 + cat.track;
}
