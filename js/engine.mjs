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

// 找抽法：用金券單抽與 11 連抽組合，找出抽到全部目標的路線
// limits: { tickets, eleven }；priority: "draws" | "tickets" | "food"
// 回傳 { steps: [{ action, cats:[cat], next }], tickets, eleven, next } 或 null
export function findPlan(startCat, goalIds, limits, priority, guaranteedRolls) {
  const all = (1 << goalIds.length) - 1;
  const bit = id => goalIds.reduce((b, g, i) => b | (g === id ? 1 << i : 0), 0);
  const rank = n => {
    const draws = n.t + 11 * n.e;
    if (priority === "tickets") return [n.e, n.t, draws];
    if (priority === "food") return [n.t, n.e, draws];
    return [draws, n.e, n.t];
  };
  const cmp = (a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return a.order - b.order;
  };
  const heap = [], seen = new Map();
  let order = 0;
  const push = n => {
    if (!n.cat || n.t > limits.tickets || n.e > limits.eleven) return;
    const key = n.cat.number + "/" + n.mask;
    const peers = seen.get(key) || [];
    if (peers.some(p => p.alive && p.t <= n.t && p.e <= n.e)) return;
    for (const p of peers) if (n.t <= p.t && n.e <= p.e) p.alive = false;
    n.alive = true; n.order = order++;
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
  push({ cat: startCat, mask: 0, t: 0, e: 0, prev: null });
  while (heap.length) {
    const n = pop();
    if (!n.alive) continue;
    if (n.mask === all) {
      const steps = [];
      for (let x = n; x.prev; x = x.prev) steps.unshift({ action: x.action, cats: x.cats, next: x.cat });
      return { steps, tickets: n.t, eleven: n.e, next: n.cat };
    }
    // 金券單抽
    push({ cat: n.cat.next, mask: n.mask | bit(n.cat.id), t: n.t + 1, e: n.e,
      prev: n, action: "ticket", cats: [n.cat] });
    // 11 連抽：保證池最後一抽換成超激
    const cats = [];
    let c = n.cat;
    const normal = guaranteedRolls === 11 && n.cat.guaranteed ? 10 : 11;
    for (let i = 0; i < normal && c; i++) { cats.push(c); c = c.next; }
    if (cats.length === normal) {
      let next = c;
      if (normal === 10) { cats.push(n.cat.guaranteed); next = n.cat.guaranteed.next; }
      push({ cat: next, mask: cats.reduce((m, x) => m | bit(x.id), n.mask), t: n.t, e: n.e + 1,
        prev: n, action: "eleven", cats });
    }
  }
  return null;
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
