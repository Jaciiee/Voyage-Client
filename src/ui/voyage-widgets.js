/**
 * Voyage Custom Browser UI & HUD Widgets (#10):
 *  1. Live EXP/hr & DPS Meter overlay (collapsible, draggable, resettable, toggleable via /meter).
 *  2. Rare Drop Loot Beams (canvas light pillar + halo) & Toast Notifications (/lootbeams).
 *  3. In-Game Drop Wiki Modal (right-click a monster on map, click "Drops", F9, or /drops [query]).
 */
import { el } from './dom.js';
import { pad } from '../assets.js';
import { CharacterLook, drawParts, lookCanvases } from '../character.js';
import { EXP, itemIcon, itemName } from '../data.js';
import { settings, saveSettings } from '../settings.js';
import { snapPx } from '../view.js';

const EXP_WINDOW_MS = 10 * 60 * 1000;
const LIVE_DPS_WINDOW_MS = 10 * 1000;
const COMBAT_GAP_MS = 15 * 1000;
const TOAST_MAX = 4;
const TOAST_MS = 4800;

const RARITY_STYLES = {
  mythic: {
    label: 'MYTHIC DROP',
    beamTop: 'rgba(255, 196, 56, 0)',
    beamMid: 'rgba(255, 168, 38, 0.36)',
    beamCore: 'rgba(255, 240, 175, 0.72)',
    ring: 'rgba(255, 196, 56, 0.85)',
    badge: '#ffb703',
  },
  rare: {
    label: 'RARE DROP',
    beamTop: 'rgba(184, 107, 255, 0)',
    beamMid: 'rgba(168, 85, 247, 0.34)',
    beamCore: 'rgba(235, 200, 255, 0.65)',
    ring: 'rgba(192, 132, 252, 0.82)',
    badge: '#c084fc',
  },
  uncommon: {
    label: 'EQUIP DROP',
    beamTop: 'rgba(56, 189, 248, 0)',
    beamMid: 'rgba(56, 189, 248, 0.28)',
    beamCore: 'rgba(195, 238, 255, 0.56)',
    ring: 'rgba(56, 189, 248, 0.78)',
    badge: '#38bdf8',
  },
};

const MYTHIC_IDS = new Set([
  2340000, // White Scroll
  2049100, // Chaos Scroll 60%
  1122000, // Horntail Necklace
  1002357, // Zakum Helmet
  1122900, 1122901, 1122902, 1122903, 1122904, // Heart of Maple tiers
]);
const RARE_IDS = new Set([
  5220000, // Gachapon Ticket
  5451000, // Remote Gachapon Ticket
]);

export function classifyDropRarity(d) {
  if (!d || d.meso || !d.id) return null;
  const id = Number(d.id);
  const cat = Math.floor(id / 10000);
  if (cat === 238) return null; // Monster Book cards already sparkle natively
  if (MYTHIC_IDS.has(id) || cat === 228 || cat === 229) return 'mythic';
  if (RARE_IDS.has(id) || cat === 204) return 'rare';
  if (id >= 1000000 && id < 2000000) return d.type === 3 ? 'mythic' : 'uncommon';
  if (cat === 210) return 'uncommon'; // Summoning bags
  if (d.type === 3 && Math.floor(id / 1000000) !== 4) return 'rare'; // Boss explosive non-Etc reward
  return null;
}

function classifyDropItemId(id) {
  const tier = classifyDropRarity({ id, meso: false, type: 0 });
  if (tier) return tier;
  if (Math.floor(id / 1000000) === 4) return 'etc';
  return 'common';
}

function fmtNum(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString();
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '--';
  if (sec >= 360000) return '>99h';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function fmtPct(pct) {
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  return `${pct.toFixed(4)}%`;
}

async function drawNodeIntoCanvas(assets, node, canvas, maxSize = 28) {
  if (!node) return;
  await assets.preload([node]);
  const img = assets.image(node);
  if (!img || !img.width || !img.height) return;
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
}

function makeItemIconEl(assets, itemId, size = 28) {
  const c = el('canvas', { class: 'vw-icon', width: size, height: size });
  itemIcon(assets, itemId, false)
    .then((node) => drawNodeIntoCanvas(assets, node, c, size))
    .catch(() => {});
  return c;
}

function makeMobIconEl(assets, mobId, size = 48) {
  const c = el('canvas', { class: 'vw-mob-art', width: size, height: size });
  assets.json(`Mob/${pad(mobId, 7)}.img`).then(async (tree) => {
    const link = tree?.info?.link;
    const src = link ? await assets.json(`Mob/${pad(link, 7)}.img`) : tree;
    const node = src?.stand?.[0] || src?.fly?.[0] || src?.move?.[0] || null;
    await drawNodeIntoCanvas(assets, node, c, size);
  }).catch(() => {});
  return c;
}

export class VoyageWidgets {
  constructor(game, root) {
    this.game = game;
    this.assets = game.assets;
    this.root = root;

    this.collapsed = false;
    this.seenDrops = new Set();
    this.dropCache = new Map();
    this.itemReverseCache = new Map();
    this.searchIndexPromise = null;
    this.wikiOverlay = null;

    this.resetStats();
    this.buildDom();
    this.renderTimer = setInterval(() => this.renderMeter(), 250);
  }

  destroy() {
    clearInterval(this.renderTimer);
    this.meterEl?.remove();
    this.toastWrap?.remove();
    this.wikiOverlay?.remove();
  }

  resetStats() {
    const now = performance.now();
    this.startedAt = now;
    this.totalExp = 0;
    this.expEvents = [];
    this.totalDamage = 0;
    this.hitLines = 0;
    this.critLines = 0;
    this.maxHit = 0;
    this.dmgEvents = [];
    this.combatActiveMs = 0;
    this.lastHitAt = 0;
    this.renderMeter();
  }

  buildDom() {
    this.toastWrap = el('div', { class: 'vw-toast-wrap' });

    this.liveDpsVal = el('span', { class: 'vw-val' }, '0/s');
    this.avgDpsVal = el('span', { class: 'vw-sub' }, 'Avg 0/s');
    this.critVal = el('span', { class: 'vw-val' }, '0%');
    this.maxHitVal = el('span', { class: 'vw-sub' }, 'Max 0');
    this.expHrVal = el('span', { class: 'vw-val gold' }, '0/hr');
    this.ttlVal = el('span', { class: 'vw-sub' }, 'TTL --');
    this.sessionVal = el('span', { class: 'vw-foot' }, '00:00  |  +0 EXP');

    this.toggleBtn = el('button', {
      class: 'vw-btn',
      title: 'Collapse / Expand',
      onclick: (e) => {
        e.stopPropagation();
        this.collapsed = !this.collapsed;
        this.meterEl.classList.toggle('collapsed', this.collapsed);
        this.toggleBtn.textContent = this.collapsed ? '+' : '—';
      },
    }, '—');

    this.headerEl = el('div', { class: 'vw-header' },
      el('span', { class: 'vw-title' }, 'LIVE METER'),
      el('div', { class: 'vw-actions' },
        el('button', {
          class: 'vw-btn wiki',
          title: 'Open Drop Wiki (F9 or /drops)',
          onclick: (e) => { e.stopPropagation(); this.openDropWiki(); },
        }, 'Drops'),
        el('button', {
          class: 'vw-btn',
          title: 'Reset session stats',
          onclick: (e) => { e.stopPropagation(); this.resetStats(); },
        }, '↺'),
        this.toggleBtn,
      ),
    );

    this.bodyEl = el('div', { class: 'vw-body' },
      el('div', { class: 'vw-grid' },
        el('div', { class: 'vw-cell' },
          el('div', { class: 'vw-lbl' }, 'EXP / HR'),
          this.expHrVal,
          this.ttlVal,
        ),
        el('div', { class: 'vw-cell' },
          el('div', { class: 'vw-lbl' }, 'DPS (10s)'),
          this.liveDpsVal,
          this.avgDpsVal,
        ),
        el('div', { class: 'vw-cell' },
          el('div', { class: 'vw-lbl' }, 'CRIT / MAX'),
          this.critVal,
          this.maxHitVal,
        ),
      ),
      this.sessionVal,
    );

    this.meterEl = el('div', { class: 'vw-meter' }, this.headerEl, this.bodyEl);
    this.enableDrag(this.headerEl, this.meterEl);
    this.syncVisibility();

    this.root.append(this.meterEl, this.toastWrap);
  }

  enableDrag(handle, target) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = target.getBoundingClientRect();
      const parentRect = target.parentElement.getBoundingClientRect();
      drag = {
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
        px: parentRect.left,
        py: parentRect.top,
      };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.max(4, Math.min(this.root.clientWidth - target.offsetWidth - 4, e.clientX - drag.px - drag.ox));
      const y = Math.max(4, Math.min(this.root.clientHeight - target.offsetHeight - 4, e.clientY - drag.py - drag.oy));
      target.style.left = `${x}px`;
      target.style.top = `${y}px`;
      target.style.right = 'auto';
    });
    const end = () => { drag = null; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  syncVisibility() {
    if (!this.meterEl) return;
    const hide = !settings.hudMeter || this.game.inCashShop || this.game.uiLocked;
    this.meterEl.style.display = hide ? 'none' : '';
  }

  // ------------------------------------------------------------------ Data Hooks
  recordExp(amount, bonus = null) {
    const base = Math.max(0, Number(amount) || 0);
    const b = bonus || {};
    const extra = Math.max(0, Number(b.equip) || 0)
      + Math.max(0, Number(b.wedding) || 0)
      + Math.max(0, Number(b.party) || 0)
      + Math.max(0, Number(b.cafe) || 0)
      + Math.max(0, Number(b.event) || 0)
      + Math.max(0, Number(b.rainbow) || 0);
    const total = base + extra;
    if (total <= 0) return;

    const now = performance.now();
    this.totalExp += total;
    this.expEvents.push({ t: now, v: total });
    this.pruneSamples(now);
  }

  recordDamage(dmgs, crits = []) {
    if (!Array.isArray(dmgs) || !dmgs.length) return;
    const now = performance.now();
    let sum = 0;
    let lines = 0;
    let critCount = 0;
    for (let i = 0; i < dmgs.length; i++) {
      const v = Number(dmgs[i]) || 0;
      if (v <= 0) continue;
      sum += v;
      lines++;
      if (v > this.maxHit) this.maxHit = v;
      if (crits[i]) critCount++;
    }
    if (sum <= 0) return;

    if (this.lastHitAt && now - this.lastHitAt <= COMBAT_GAP_MS) {
      this.combatActiveMs += Math.max(0, now - this.lastHitAt);
    } else {
      this.combatActiveMs += 1000;
    }
    this.lastHitAt = now;

    this.totalDamage += sum;
    this.hitLines += lines;
    this.critLines += critCount;
    this.dmgEvents.push({ t: now, v: sum });
    this.pruneSamples(now);
  }

  pruneSamples(now) {
    while (this.expEvents.length && now - this.expEvents[0].t > EXP_WINDOW_MS) this.expEvents.shift();
    while (this.dmgEvents.length && now - this.dmgEvents[0].t > LIVE_DPS_WINDOW_MS) this.dmgEvents.shift();
  }

  renderMeter() {
    this.syncVisibility();
    if (!this.meterEl || !settings.hudMeter || this.game.inCashShop) return;

    const now = performance.now();
    this.pruneSamples(now);

    // Live 10s DPS
    let recentDmg = 0;
    for (const e of this.dmgEvents) recentDmg += e.v;
    const activeWindowSec = this.dmgEvents.length
      ? Math.max(1.5, Math.min(10, (now - this.dmgEvents[0].t) / 1000 + 1))
      : 10;
    const liveDps = recentDmg / activeWindowSec;
    const avgDps = this.combatActiveMs > 0 ? this.totalDamage / (this.combatActiveMs / 1000) : 0;

    // EXP/hr over up to 10-min rolling window (scaled smoothly)
    let recentExp = 0;
    for (const e of this.expEvents) recentExp += e.v;
    const expElapsedMs = this.expEvents.length
      ? Math.max(5000, Math.min(EXP_WINDOW_MS, now - Math.max(this.startedAt, now - EXP_WINDOW_MS)))
      : Math.max(1000, now - this.startedAt);
    const expPerHr = this.expEvents.length ? (recentExp * 3600000) / expElapsedMs : 0;

    const lv = this.game.stats?.level || 1;
    const needed = EXP[lv] || 0;
    const curExp = this.game.stats?.exp || 0;
    const remainingExp = Math.max(0, needed - curExp);
    const ttlSec = expPerHr > 0 && remainingExp > 0 ? (remainingExp / expPerHr) * 3600 : 0;
    const expPctGain = needed > 0 ? ((this.totalExp / needed) * 100).toFixed(1) : '0.0';

    const critPct = this.hitLines > 0 ? Math.round((this.critLines / this.hitLines) * 100) : 0;
    const sessionSec = Math.floor((now - this.startedAt) / 1000);
    const mm = String(Math.floor(sessionSec / 60)).padStart(2, '0');
    const ss = String(sessionSec % 60).padStart(2, '0');

    this.expHrVal.textContent = `${fmtNum(expPerHr)}/hr`;
    this.ttlVal.textContent = `TTL ${fmtDuration(ttlSec)}`;
    this.liveDpsVal.textContent = `${fmtNum(liveDps)}/s`;
    this.avgDpsVal.textContent = `Avg ${fmtNum(avgDps)}/s`;
    this.critVal.textContent = `${critPct}% Crit`;
    this.maxHitVal.textContent = `Max ${fmtNum(this.maxHit)}`;
    this.sessionVal.textContent = `${mm}:${ss} | +${fmtNum(this.totalExp)} EXP (${expPctGain}%)`;
  }

  // ------------------------------------------------------------------ Rare Drop Loot Beams & Toasts
  clearMapDrops() {
    this.seenDrops.clear();
  }

  async onDropSpawn(d) {
    if (!d || this.seenDrops.has(d.oid)) return;
    const rarity = classifyDropRarity(d);
    if (!rarity) return;
    this.seenDrops.add(d.oid);

    const style = RARITY_STYLES[rarity];
    const name = await itemName(this.assets, d.id).catch(() => `Item #${d.id}`);
    const card = el('div', { class: `vw-toast ${rarity}` },
      el('div', { class: 'vw-toast-icon' }, makeItemIconEl(this.assets, d.id, 30)),
      el('div', { class: 'vw-toast-text' },
        el('div', { class: 'vw-toast-tag', style: `color:${style.badge}` }, style.label),
        el('div', { class: 'vw-toast-name' }, name),
      ),
    );
    this.toastWrap.prepend(card);
    while (this.toastWrap.children.length > TOAST_MAX) {
      this.toastWrap.lastElementChild?.remove();
    }
    setTimeout(() => {
      card.classList.add('fade');
      setTimeout(() => card.remove(), 350);
    }, TOAST_MS);
  }

  drawLootBeam(ctx, cam, d, x, groundY) {
    if (settings.lootBeams === false || d.pickedBy) return;
    const rarity = classifyDropRarity(d);
    if (!rarity) return;
    const style = RARITY_STYLES[rarity];
    const now = performance.now();
    const pulse = 0.8 + 0.2 * Math.sin(now / 170 + (d.oid % 17));

    const sx = snapPx(x - cam.x);
    const sy = snapPx(groundY - cam.y);
    const h = rarity === 'mythic' ? 145 : rarity === 'rare' ? 115 : 82;
    const w = rarity === 'mythic' ? 30 : rarity === 'rare' ? 24 : 18;

    ctx.save();
    ctx.globalAlpha = d.alpha * pulse;
    ctx.globalCompositeOperation = 'lighter';

    const grad = ctx.createLinearGradient(sx, sy - h, sx, sy + 2);
    grad.addColorStop(0, style.beamTop);
    grad.addColorStop(0.55, style.beamMid);
    grad.addColorStop(1, style.beamCore);
    ctx.fillStyle = grad;
    ctx.fillRect(sx - w / 2, sy - h, w, h + 2);

    // Narrow bright inner shaft
    ctx.fillStyle = style.beamCore;
    ctx.fillRect(sx - 2, sy - h * 0.72, 4, h * 0.72 + 2);

    // Ground glow halo
    ctx.beginPath();
    ctx.ellipse(sx, sy + 1, w * 0.75 * pulse, 5.5 * pulse, 0, 0, Math.PI * 2);
    ctx.strokeStyle = style.ring;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ Drop Wiki Modal
  async ensureSearchIndex() {
    if (this.searchIndexPromise) return this.searchIndexPromise;
    this.searchIndexPromise = (async () => {
      const [mobStr, eqpStr, conStr, etcStr, insStr, cashStr] = await Promise.all([
        this.assets.json('String/Mob.img').catch(() => null),
        this.assets.json('String/Eqp.img').catch(() => null),
        this.assets.json('String/Consume.img').catch(() => null),
        this.assets.json('String/Etc.img').catch(() => null),
        this.assets.json('String/Ins.img').catch(() => null),
        this.assets.json('String/Cash.img').catch(() => null),
      ]);

      const mobs = [];
      for (const [id, entry] of Object.entries(mobStr || {})) {
        if (/^\d+$/.test(id) && entry?.name) {
          mobs.push({ kind: 'mob', id: Number(id), name: entry.name, low: entry.name.toLowerCase() });
        }
      }

      const items = [];
      const addItem = (id, name) => {
        if (/^\d+$/.test(id) && name) items.push({ kind: 'item', id: Number(id), name, low: name.toLowerCase() });
      };
      for (const cat of Object.values(eqpStr?.Eqp || {})) {
        for (const [id, entry] of Object.entries(cat || {})) addItem(id, entry?.name);
      }
      for (const [id, entry] of Object.entries(conStr || {})) addItem(id, entry?.name);
      for (const [id, entry] of Object.entries(etcStr?.Etc || {})) addItem(id, entry?.name);
      for (const [id, entry] of Object.entries(insStr || {})) addItem(id, entry?.name);
      for (const [id, entry] of Object.entries(cashStr || {})) addItem(id, entry?.name);

      return { mobs, items, mobMap: new Map(mobs.map((m) => [m.id, m.name])) };
    })();
    return this.searchIndexPromise;
  }

  currentMapMobs() {
    const out = new Map();
    for (const e of this.game.map?.life || []) {
      if (e.kind !== 'Mob') continue;
      const id = Number(e.spawn?.id || e.id);
      if (!id || out.has(id)) continue;
      out.set(id, e.name || `Mob #${id}`);
    }
    return [...out.entries()].map(([id, name]) => ({ id, name }));
  }

  async openDropWikiMob(mobId) {
    await this.openDropWiki('');
    this.selectMob(Number(mobId));
  }

  async openDropWiki(initialQuery = '') {
    if (this.wikiOverlay) {
      this.wikiOverlay.remove();
      this.wikiOverlay = null;
    }

    const searchInput = el('input', {
      class: 'vw-wiki-search',
      type: 'text',
      placeholder: 'Search monster or item name (e.g. Mushmom, Chaos Scroll, Gachapon)...',
      value: initialQuery || '',
      oninput: () => this.runSearch(searchInput.value),
    });
    // Prevent game keybinds from firing while typing in search
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      searchInput.addEventListener(ev, (e) => e.stopPropagation());
    }

    this.mapChipsEl = el('div', { class: 'vw-chips' });
    this.wikiContentEl = el('div', { class: 'vw-wiki-content' },
      el('div', { class: 'vw-empty' }, 'Pick a monster from this map above or type to search drops.'),
    );

    const closeModal = () => {
      this.wikiOverlay?.remove();
      this.wikiOverlay = null;
    };

    const modalEl = el('div', { class: 'panel vw-wiki-modal', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'vw-wiki-top' },
        el('div', {},
          el('h3', {}, 'In-Game Drop Wiki'),
          el('span', { class: 'hint' }, 'Right-click any monster on the map, press F9, or type /drops'),
        ),
        el('button', { onclick: closeModal }, '✕'),
      ),
      el('div', { class: 'vw-search-row' },
        searchInput,
        el('button', { class: 'primary', onclick: () => this.runSearch(searchInput.value) }, 'Search'),
      ),
      el('div', { class: 'vw-section-lbl' }, 'Monsters in Current Map:'),
      this.mapChipsEl,
      this.wikiContentEl,
    );

    const overlay = el('div', { class: 'modal-overlay vw-overlay', onclick: closeModal }, modalEl);
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeModal();
        removeEventListener('keydown', escHandler, true);
      }
    };
    addEventListener('keydown', escHandler, true);

    this.wikiOverlay = overlay;
    document.body.append(overlay);

    const mapMobs = this.currentMapMobs();
    if (!mapMobs.length) {
      this.mapChipsEl.append(el('span', { class: 'hint' }, 'No monsters spawned on this map.'));
    } else {
      for (const m of mapMobs) {
        this.mapChipsEl.append(
          el('button', {
            class: 'vw-chip',
            onclick: () => this.selectMob(m.id),
          }, makeMobIconEl(this.assets, m.id, 22), m.name),
        );
      }
    }

    setTimeout(() => searchInput.focus(), 10);
    if (initialQuery && initialQuery.trim()) {
      await this.runSearch(initialQuery.trim());
    } else if (mapMobs.length) {
      await this.selectMob(mapMobs[0].id);
    }
  }

  async runSearch(raw) {
    if (!this.wikiOverlay) return;
    const q = (raw || '').trim().toLowerCase();
    if (!q) return;

    this.wikiContentEl.replaceChildren(el('div', { class: 'vw-empty' }, 'Searching game index...'));
    const idx = await this.ensureSearchIndex();

    const mobMatches = [];
    for (const m of idx.mobs) {
      if (m.low.includes(q) || String(m.id) === q) {
        mobMatches.push(m);
        if (mobMatches.length >= 24) break;
      }
    }
    const itemMatches = [];
    for (const it of idx.items) {
      if (it.low.includes(q) || String(it.id) === q) {
        itemMatches.push(it);
        if (itemMatches.length >= 24) break;
      }
    }

    if (mobMatches.length === 1 && itemMatches.length === 0) {
      await this.selectMob(mobMatches[0].id);
      return;
    }

    const wrap = el('div', { class: 'vw-search-results' });
    if (mobMatches.length) {
      wrap.append(el('div', { class: 'vw-section-lbl' }, `Monsters (${mobMatches.length}${mobMatches.length === 24 ? '+' : ''})`));
      const grid = el('div', { class: 'vw-result-grid' });
      for (const m of mobMatches) {
        grid.append(el('button', {
          class: 'vw-result-card',
          onclick: () => this.selectMob(m.id),
        }, makeMobIconEl(this.assets, m.id, 30), el('span', {}, m.name)));
      }
      wrap.append(grid);
    }
    if (itemMatches.length) {
      wrap.append(el('div', { class: 'vw-section-lbl' }, `Items — click to see what drops them (${itemMatches.length}${itemMatches.length === 24 ? '+' : ''})`));
      const grid = el('div', { class: 'vw-result-grid' });
      for (const it of itemMatches) {
        grid.append(el('button', {
          class: 'vw-result-card',
          onclick: () => this.selectItem(it.id, it.name),
        }, makeItemIconEl(this.assets, it.id, 26), el('span', {}, it.name)));
      }
      wrap.append(grid);
    }
    if (!mobMatches.length && !itemMatches.length) {
      wrap.append(el('div', { class: 'vw-empty' }, `No monsters or items found matching "${raw}".`));
    }
    this.wikiContentEl.replaceChildren(wrap);
  }

  async fetchMobDrops(mobId) {
    const mapId = this.game.map?.id || 0;
    const key = `${mobId}:${Math.floor(mapId / 100000000)}`;
    if (this.dropCache.has(key)) return this.dropCache.get(key);
    const params = new URLSearchParams({ mob: String(mobId) });
    if (mapId) params.set('map', String(mapId));
    const res = await fetch(`/api/drops?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.dropCache.set(key, data);
    return data;
  }

  async selectMob(mobId) {
    if (!this.wikiOverlay) return;
    this.wikiContentEl.replaceChildren(el('div', { class: 'vw-empty' }, `Loading drops for Monster #${mobId}...`));
    try {
      const data = await this.fetchMobDrops(mobId);
      const header = el('div', { class: 'vw-mob-header' },
        makeMobIconEl(this.assets, mobId, 56),
        el('div', { class: 'vw-mob-meta' },
          el('div', { class: 'vw-mob-title' },
            el('strong', {}, data.name || `Mob #${mobId}`),
            data.boss ? el('span', { class: 'vw-pill boss' }, 'BOSS') : '',
            el('span', { class: 'vw-pill' }, `Lv. ${data.level || '?'}`),
          ),
          el('div', { class: 'hint' },
            `HP: ${(data.hp || 0).toLocaleString()}   |   EXP: ${(data.exp || 0).toLocaleString()}   |   Server Drop Rate: ${data.dropRate || 1}x`,
          ),
        ),
      );

      const list = el('div', { class: 'vw-drop-list' });
      const entries = [
        ...(data.drops || []).map((d) => ({ ...d, global: false })),
        ...(data.globalDrops || []).map((d) => ({ ...d, global: true })),
      ].filter((d) => d.itemId > 0);

      entries.sort((a, b) => (a.global === b.global ? b.ratePct - a.ratePct : a.global ? 1 : -1));

      if (!entries.length) {
        list.append(el('div', { class: 'vw-empty' }, 'No item drops recorded for this monster.'));
      } else {
        for (const d of entries) {
          const rarity = classifyDropItemId(d.itemId);
          const nameSpan = el('span', { class: `vw-drop-name ${rarity}` }, `Loading #${d.itemId}...`);
          itemName(this.assets, d.itemId).then((n) => { nameSpan.textContent = n; }).catch(() => {});

          const qtyText = d.minQty === d.maxQty ? (d.minQty > 1 ? `x${d.minQty}` : '') : `x${d.minQty}-${d.maxQty}`;
          const row = el('div', {
            class: 'vw-drop-row',
            title: 'Click to see all monsters that drop this item',
            onclick: () => this.selectItem(d.itemId, nameSpan.textContent),
          },
            makeItemIconEl(this.assets, d.itemId, 28),
            el('div', { class: 'vw-drop-info' },
              nameSpan,
              el('span', { class: 'vw-drop-sub' },
                qtyText ? `${qtyText}  ` : '',
                d.questId > 0 ? `[Quest #${d.questId}] ` : '',
                d.global ? '[Global Drop]' : '',
              ),
            ),
            el('div', { class: 'vw-drop-rate' }, fmtPct(d.ratePct)),
          );
          list.append(row);
        }
      }
      this.wikiContentEl.replaceChildren(header, list);
    } catch (err) {
      this.wikiContentEl.replaceChildren(el('div', { class: 'vw-empty' }, `Failed to load drops: ${err.message}`));
    }
  }

  async selectItem(itemId, knownName = '') {
    if (!this.wikiOverlay) return;
    const title = knownName || (await itemName(this.assets, itemId).catch(() => `Item #${itemId}`));
    this.wikiContentEl.replaceChildren(el('div', { class: 'vw-empty' }, `Finding monsters that drop ${title}...`));
    try {
      let data = this.itemReverseCache.get(itemId);
      if (!data) {
        const res = await fetch(`/api/drops?item=${encodeURIComponent(itemId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        this.itemReverseCache.set(itemId, data);
      }
      const idx = await this.ensureSearchIndex();

      const header = el('div', { class: 'vw-mob-header' },
        makeItemIconEl(this.assets, itemId, 36),
        el('div', { class: 'vw-mob-meta' },
          el('div', { class: 'vw-mob-title' }, el('strong', {}, title), el('span', { class: 'vw-pill' }, `#${itemId}`)),
          el('div', { class: 'hint' }, data.global ? 'Global Drop — can drop from any monster on the continent!' : `Dropped by ${data.mobs.length}${data.mobs.length >= 60 ? '+' : ''} monster(s)`),
        ),
      );

      const grid = el('div', { class: 'vw-result-grid' });
      for (const mobId of data.mobs) {
        const mobName = idx.mobMap.get(mobId) || `Mob #${mobId}`;
        grid.append(el('button', {
          class: 'vw-result-card',
          onclick: () => this.selectMob(mobId),
        }, makeMobIconEl(this.assets, mobId, 30), el('span', {}, mobName)));
      }
      if (!data.mobs.length && !data.global) {
        grid.append(el('div', { class: 'vw-empty' }, 'No monster drops found in database (may come from Gachapon, NPCs, or quests).'));
      }
      this.wikiContentEl.replaceChildren(header, grid);
    } catch (err) {
      this.wikiContentEl.replaceChildren(el('div', { class: 'vw-empty' }, `Lookup failed: ${err.message}`));
    }
  }

  // ------------------------------------------------------------------ 4. GM Ported Items Shop (!portshop)
  async openPortShop() {
    if (this.portOverlay) {
      this.portOverlay.remove();
      this.portOverlay = null;
    }

    const searchInput = el('input', {
      class: 'vw-wiki-search',
      type: 'text',
      placeholder: 'Filter ported items by name or ID (e.g. Aurora, Blossoming, 1005802)...',
    });
    for (const ev of ['keydown', 'keyup', 'keypress']) {
      searchInput.addEventListener(ev, (e) => e.stopPropagation());
    }

    const catsEl = el('div', { class: 'vw-chips vw-port-cats' });
    const gridEl = el('div', { class: 'vw-wiki-content vw-port-content' },
      el('div', { class: 'vw-empty' }, 'Loading ported items catalog...'),
    );
    const pagerEl = el('div', { class: 'vw-port-pager' });
    const statusEl = el('span', { class: 'vw-port-status' }, 'Click Hair/Face to preview before applying, or any item to receive it.');

    const s0 = this.game.stats || {};
    const origHair = s0.hair || 30030;
    const origFace = s0.face || 20000;
    let previewHair = origHair;
    let previewFace = origFace;
    let previewExpr = '';
    let previewRight = false;
    let hideHat = false;
    let previewBgIdx = 2; // Outdoor park Cash Shop preview backdrop (0: studio, 1: forest, 2: outdoor)
    let previewBgNodes = null;
    let previewLook = null;
    let previewSeq = 0;
    let previewRaf = 0;
    let active = true;

    const previewCanvas = el('canvas', { class: 'vw-port-preview-canvas', width: 212, height: 165 });
    const hairLabelEl = el('div', { class: 'vw-port-preview-meta' }, `Hair: #${previewHair}`);
    const faceLabelEl = el('div', { class: 'vw-port-preview-meta' }, `Face: #${previewFace}`);
    const nameMap = new Map();

    this.game.assets.json('UI/CashShop.img').then((cs) => {
      if (!active || !cs?.Base?.Preview) return;
      previewBgNodes = [cs.Base.Preview[0], cs.Base.Preview[1], cs.Base.Preview[2]];
      this.game.assets.preload(previewBgNodes.filter(Boolean));
    });

    const getEquippedIds = () => {
      const eq = this.game.inventory?.equipped || {};
      const bySlot = {};
      for (const [k, it] of Object.entries(eq)) {
        const slot = Number(k);
        if (slot > -100) bySlot[-slot] ??= it.id;
      }
      for (const [k, it] of Object.entries(eq)) {
        const slot = Number(k);
        if (slot <= -100 && slot !== -111) bySlot[-slot - 100] = it.id;
      }
      let ids = Object.values(bySlot).filter((id) => !hideHat || Math.floor(id / 10000) !== 100);
      if (eq[-111]) ids.push(eq[-111].id);
      return ids;
    };

    const labelFor = (prefix, id, origId) => {
      const nm = nameMap.get(id);
      const tag = id === origId ? ' (Original)' : ' (Try-on)';
      return `${prefix}: ${nm ? `${nm} ` : ''}#${id}${tag}`;
    };

    const syncLabels = () => {
      hairLabelEl.textContent = labelFor('Hair', previewHair, origHair);
      faceLabelEl.textContent = labelFor('Face', previewFace, origFace);
    };

    const loadPreviewLook = async () => {
      const seq = ++previewSeq;
      syncLabels();
      const st = this.game.stats || {};
      const look = new CharacterLook(this.game.assets, {
        skin: st.skin || 0,
        face: previewFace,
        hair: previewHair,
        gender: st.gender ?? null,
        equips: getEquippedIds(),
      });
      await look.load();
      if (!active || seq !== previewSeq) return;
      const act = look.standAction();
      await this.game.assets.preload(lookCanvases(look, [act]));
      if (!active || seq !== previewSeq) return;
      if (previewExpr && look.face?.[previewExpr]) {
        await this.game.assets.preload([look.face[previewExpr], ...Object.values(look.face[previewExpr] || {})]);
      }
      if (!active || seq !== previewSeq) return;
      previewLook = look;
    };

    const drawPreviewLoop = () => {
      if (!active) return;
      const ctx = previewCanvas.getContext('2d');
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.imageSmoothingEnabled = false;
      const bgNode = previewBgNodes?.[previewBgIdx];
      const bgImg = bgNode ? this.game.assets.image(bgNode) : null;
      if (bgImg) ctx.drawImage(bgImg, 0, 0);
      if (previewLook?.loaded) {
        const act = previewLook.standAction();
        const n = previewLook.frameCount(act) || 1;
        const f = Math.floor(performance.now() / 300) % n;
        const expr = previewExpr ? { name: previewExpr, frame: 0 } : null;
        const parts = previewLook.compose(act, f, expr);
        const scale = 1.5;
        ctx.save();
        ctx.scale(scale, scale);
        drawParts(ctx, this.game.assets, parts, 94 / scale, 133 / scale, previewRight, 1, false);
        ctx.restore();
      }
      previewRaf = requestAnimationFrame(drawPreviewLoop);
    };

    const exprSelect = el('select', {
      class: 'vw-port-select',
      title: 'Preview face expression',
      onchange: (e) => { previewExpr = e.target.value; loadPreviewLook(); },
    },
      el('option', { value: '' }, 'Expr: Default'),
      el('option', { value: 'blink' }, 'Expr: Blink'),
      el('option', { value: 'smile' }, 'Expr: Smile'),
      el('option', { value: 'troubled' }, 'Expr: Troubled'),
      el('option', { value: 'cry' }, 'Expr: Cry'),
      el('option', { value: 'angry' }, 'Expr: Angry'),
      el('option', { value: 'bewildered' }, 'Expr: Bewildered'),
      el('option', { value: 'stunned' }, 'Expr: Stunned'),
    );
    const hatBtn = el('button', {
      class: 'vw-chip',
      onclick: () => {
        hideHat = !hideHat;
        hatBtn.classList.toggle('active', hideHat);
        hatBtn.textContent = hideHat ? 'Hat: Hidden' : 'Hide Hat';
        loadPreviewLook();
      },
    }, 'Hide Hat');
    const flipBtn = el('button', {
      class: 'vw-chip',
      onclick: () => { previewRight = !previewRight; },
    }, 'Flip');
    const bgBtn = el('button', {
      class: 'vw-chip',
      title: 'Cycle Cash Shop preview backdrop',
      onclick: () => { previewBgIdx = (previewBgIdx + 1) % 3; },
    }, 'BG');

    const applyStyleBtn = el('button', {
      class: 'vw-chip active vw-port-btn-full',
      onclick: () => {
        const curHair = this.game.stats?.hair;
        const curFace = this.game.stats?.face;
        let sent = 0;
        if (previewHair && previewHair !== curHair) {
          this.game.net?.chat(`!portshop ${previewHair}`);
          sent++;
        }
        if (previewFace && previewFace !== curFace) {
          this.game.net?.chat(`!portshop ${previewFace}`);
          sent++;
        }
        statusEl.textContent = sent
          ? `Applied previewed style (Hair #${previewHair}, Face #${previewFace}).`
          : 'Preview already matches your character.';
      },
    }, 'Apply Style');

    const revertBtn = el('button', {
      class: 'vw-chip vw-port-btn-full',
      onclick: () => {
        previewHair = origHair;
        previewFace = origFace;
        previewExpr = '';
        exprSelect.value = '';
        loadPreviewLook();
        const curHair = this.game.stats?.hair;
        const curFace = this.game.stats?.face;
        if (origHair && curHair !== origHair) this.game.net?.chat(`!portshop ${origHair}`);
        if (origFace && curFace !== origFace) this.game.net?.chat(`!portshop ${origFace}`);
        statusEl.textContent = `Reverted to original style (Hair #${origHair}, Face #${origFace}).`;
      },
    }, 'Revert Original');

    const previewPanelEl = el('div', { class: 'vw-port-preview' },
      el('div', { class: 'vw-port-preview-title' }, 'Style Preview'),
      previewCanvas,
      hairLabelEl,
      faceLabelEl,
      el('div', { class: 'vw-port-preview-tools' }, exprSelect, hatBtn, flipBtn, bgBtn),
      el('div', { class: 'vw-port-preview-actions' }, applyStyleBtn, revertBtn),
    );

    let escHandler;
    const closeModal = () => {
      active = false;
      cancelAnimationFrame(previewRaf);
      this.portOverlay?.remove();
      this.portOverlay = null;
      if (escHandler) removeEventListener('keydown', escHandler, true);
    };
    escHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeModal();
      }
    };
    addEventListener('keydown', escHandler, true);

    const modalEl = el('div', { class: 'panel vw-wiki-modal vw-port-modal', onclick: (e) => e.stopPropagation() },
      el('div', { class: 'vw-wiki-top' },
        el('div', {},
          el('h3', {}, 'GM Ported Items Shop (!portshop)'),
          el('span', { class: 'hint' }, 'Preview Hair & Face on your character before applying, or click any equip/chair to receive it'),
        ),
        el('button', { onclick: closeModal }, '✕'),
      ),
      el('div', { class: 'vw-search-row' }, searchInput),
      catsEl,
      el('div', { class: 'vw-port-body' },
        previewPanelEl,
        gridEl,
      ),
      el('div', { class: 'vw-port-footer' }, statusEl, pagerEl),
    );

    const overlay = el('div', { class: 'modal-overlay vw-overlay', onclick: closeModal }, modalEl);
    this.portOverlay = overlay;
    document.body.append(overlay);
    setTimeout(() => searchInput.focus(), 0);
    loadPreviewLook();
    previewRaf = requestAnimationFrame(drawPreviewLoop);

    try {
      if (!this.portCatalog) {
        const res = await fetch('/api/ported');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.portCatalog = await res.json();
      }
      const catalog = this.portCatalog;
      const items = catalog.items || [];
      for (const it of items) nameMap.set(it.id, it.name);
      syncLabels();
      const cats = [{ name: 'All', count: items.length }, ...(catalog.categories || [])];
      let activeCat = 'All';
      let page = 0;
      const PAGE_SIZE = 72;

      const renderCats = () => {
        catsEl.replaceChildren();
        for (const c of cats) {
          catsEl.append(el('button', {
            class: `vw-chip${activeCat === c.name ? ' active' : ''}`,
            onclick: () => { activeCat = c.name; page = 0; renderCats(); renderGrid(); },
          }, `${c.name} (${c.count})`));
        }
      };

      const renderGrid = () => {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = items.filter((it) => {
          if (activeCat !== 'All' && it.cat !== activeCat) return false;
          if (!q) return true;
          return it.name.toLowerCase().includes(q) || String(it.id).includes(q);
        });

        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        if (page >= totalPages) page = totalPages - 1;
        const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

        const grid = el('div', { class: 'vw-port-grid' });
        if (!slice.length) {
          gridEl.replaceChildren(el('div', { class: 'vw-empty' }, 'No ported items match this filter.'));
        } else {
          for (const it of slice) {
            const imgWrap = el('div', { class: 'vw-port-icon-wrap' });
            if (it.icon) {
              imgWrap.append(el('img', {
                src: `/assets/${it.icon}`,
                loading: 'lazy',
                alt: it.name,
                onerror: function () { this.style.display = 'none'; },
              }));
            }
            const isStyle = it.cat === 'Hair' || it.cat === 'Face';
            const isPicked = (it.cat === 'Hair' && it.id === previewHair) || (it.cat === 'Face' && it.id === previewFace);
            const card = el('button', {
              class: `vw-port-card${isPicked ? ' picked' : ''}`,
              title: isStyle ? `${it.name} (#${it.id}) [${it.cat}] — Click to preview` : `${it.name} (#${it.id}) [${it.cat}] — Click to receive`,
              onclick: () => {
                if (it.cat === 'Hair') {
                  previewHair = it.id;
                  loadPreviewLook();
                  renderGridPreservingScroll();
                  statusEl.textContent = `Previewing Hair: ${it.name} (#${it.id}) — click "Apply Style" to apply.`;
                } else if (it.cat === 'Face') {
                  previewFace = it.id;
                  loadPreviewLook();
                  renderGridPreservingScroll();
                  statusEl.textContent = `Previewing Face: ${it.name} (#${it.id}) — click "Apply Style" to apply.`;
                } else {
                  this.game.net?.chat(`!portshop ${it.id}`);
                  statusEl.textContent = `Requested: ${it.name} (#${it.id})`;
                  card.classList.add('picked');
                  setTimeout(() => card.classList.remove('picked'), 500);
                }
              },
            },
              imgWrap,
              el('div', { class: 'vw-port-name' }, it.name),
              el('div', { class: 'vw-port-meta' }, `${it.cat} · #${it.id}`),
            );
            grid.append(card);
          }
          gridEl.replaceChildren(grid);
        }

        pagerEl.replaceChildren(
          el('span', { class: 'hint' }, `${filtered.length} item(s) · Page ${page + 1}/${totalPages}`),
          el('button', {
            class: 'vw-chip',
            disabled: page <= 0,
            onclick: () => { if (page > 0) { page--; renderGrid(); gridEl.scrollTop = 0; } },
          }, '◀ Prev'),
          el('button', {
            class: 'vw-chip',
            disabled: page >= totalPages - 1,
            onclick: () => { if (page < totalPages - 1) { page++; renderGrid(); gridEl.scrollTop = 0; } },
          }, 'Next ▶'),
        );
      };

      const renderGridPreservingScroll = () => {
        const prevTop = gridEl.scrollTop;
        renderGrid();
        gridEl.scrollTop = prevTop;
      };

      searchInput.addEventListener('input', () => { page = 0; renderGrid(); gridEl.scrollTop = 0; });
      renderCats();
      renderGrid();
      gridEl.scrollTop = 0;
    } catch (err) {
      gridEl.replaceChildren(el('div', { class: 'vw-empty' }, `Failed to load Port Shop: ${err.message}`));
    }
  }
}
