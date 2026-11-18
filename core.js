/* =====================================================================
   極速維修站 PIT CREW — 共用核心（設定 / 資料庫 / 動作偵測 / 計分 / 車輛繪圖）
   玩家端 index.html、投影端 tv.html、後台 admin.html 都會載入這支檔案
   ===================================================================== */
(function () {
  'use strict';

  /* ───────── ① Firebase 設定（三個頁面共用這一份） ─────────
     沿用 Kuya-Candy Game 專案（Blaze），資料放在 pit_crew 節點。
     網址加 ?local=1 ＝本機測試模式（同一個瀏覽器開多個分頁互通）。 */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDl_NqANwk_lsfEL5kOyC1RJi29DLvGPU8",
    authDomain: "kuya-candy-game.firebaseapp.com",
    databaseURL: "https://kuya-candy-game-default-rtdb.firebaseio.com",
    projectId: "kuya-candy-game",
    storageBucket: "kuya-candy-game.firebasestorage.app",
    messagingSenderId: "105923267148",
    appId: "1:105923267148:web:1f0e0db9de8cc2876c42e9"
  };
  const FORCE_LOCAL = /[?&]local=1\b/.test(location.search);
  const USE_FB = !!FIREBASE_CONFIG && !FORCE_LOCAL;

  const ROOT = 'pit_crew';
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

  /* 後台可調的預設值 */
  const DEFAULT_CFG = {
    title: '極速維修站',
    brand: 'PIT CREW',
    tables: '1-8',                 // 桌號清單（可寫 1-8,VIP,主桌）
    teams: [
      { n: '紅隊', c: '#ff2d55', tb: '1,2' },
      { n: '藍隊', c: '#1e9bff', tb: '3,4' },
      { n: '黃隊', c: '#ffc21a', tb: '5,6' },
      { n: '綠隊', c: '#2dd36f', tb: '7,8' }
    ],
    need1: 100,      // 第 1 關 頂車：每人平均要搖幾下（全力約 10 秒、一般約 15 秒）
    need2: 160,      // 第 2 關 換胎：每人平均要搖幾下（4 顆輪胎各 1/4；全力約 16 秒、一般約 25 秒）
    need3: 12,       // 第 3 關 加油：每人平均要拿穩幾秒
    win4: 6,         // 第 4 關 出站：綠燈後比幾秒
    grace: 10,       // 第一隊完成後再給其他隊幾秒
    maxSec: 40,      // 每關最長秒數
    swing: 7,        // 甩動門檻（m/s²，地心引力約 9.8）：往一個方向甩超過這個力道、再往反方向甩回來才算一下；越小越容易算
    rate: 10,        // 每人每秒最多算幾下（避免手機靈敏度差太多）
    wobble: 3.5,     // 加油關：晃動超過多少（m/s²）就斷油
    cut: 1           // 斷油秒數
  };

  const STAGES = [
    { key: 'jack', no: 1, name: '頂車', en: 'JACK UP',     act: 'shake',  tip: '全隊狂搖手機，把車頂起來！' },
    { key: 'tire', no: 2, name: '換胎', en: 'TIRE CHANGE', act: 'shake',  tip: '繼續狂搖！4 顆輪胎一顆一顆換' },
    { key: 'fuel', no: 3, name: '加油', en: 'REFUEL',      act: 'steady', tip: '手機直立拿穩不要動，一晃就斷油！' },
    { key: 'go',   no: 4, name: '出站', en: 'RELEASE',     act: 'burst',  tip: '等綠燈！亮了就狂搖，比誰搖最多' }
  ];

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('載入失敗：' + src));
      document.head.appendChild(s);
    });
  }

  /* ───────── Firebase 後端 ───────── */
  const FB = {
    async init() {
      await loadScript(SDK + 'firebase-app-compat.js');
      await loadScript(SDK + 'firebase-database-compat.js');
      firebase.initializeApp(FIREBASE_CONFIG);
      this.db = firebase.app().database(FIREBASE_CONFIG.databaseURL);
      this.offset = 0;
      this.db.ref('.info/serverTimeOffset').on('value', s => { this.offset = s.val() || 0; });
    },
    r(p) { return this.db.ref(p); },
    on(p, cb) {
      const ref = this.r(p); const h = s => cb(s.val());
      ref.on('value', h); return () => ref.off('value', h);
    },
    onTop(p, child, n, cb) {
      const q = this.r(p).orderByChild(child).limitToLast(n);
      const h = s => {
        const a = [];
        s.forEach(c => { const v = c.val(); if (v && typeof v === 'object') a.push(Object.assign({ key: c.key }, v)); });
        a.reverse(); cb(a);
      };
      q.on('value', h); return () => q.off('value', h);
    },
    get(p) { return this.r(p).once('value').then(s => s.val()); },
    set(p, v) { return this.r(p).set(v); },
    update(p, o) { return this.r(p).update(o); },
    remove(p) { return this.r(p).remove(); },
    txn(p, fn) { return this.r(p).transaction(fn).then(r => ({ committed: r.committed, val: r.snapshot.val() })); },
    now() { return Date.now() + this.offset; },
    onConnected(cb) { this.r('.info/connected').on('value', s => cb(s.val() === true)); }
  };

  /* ───────── 本機測試後端（localStorage，同一瀏覽器多分頁互通） ───────── */
  const LP = 'pcmock:';
  const LOCAL = {
    listeners: new Set(), pending: false,
    async init() {
      window.addEventListener('storage', e => { if (!e.key || e.key.startsWith(LP)) this.notify(); });
    },
    norm(p) { return String(p).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'); },
    keys() {
      const a = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(LP)) a.push(k); }
      return a;
    },
    read(p) {
      p = this.norm(p);
      const exact = localStorage.getItem(LP + p);
      if (exact !== null) return JSON.parse(exact);
      const pre = LP + p + '/'; let out = null;
      for (const k of this.keys()) {
        if (!k.startsWith(pre)) continue;
        const parts = k.slice(pre.length).split('/');
        out = out || {}; let o = out;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
          o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = JSON.parse(localStorage.getItem(k));
      }
      return out;
    },
    writeRaw(p, v) {
      p = this.norm(p);
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) localStorage.removeItem(LP + parts.slice(0, i).join('/'));
      localStorage.removeItem(LP + p);
      const pre = LP + p + '/';
      for (const k of this.keys()) if (k.startsWith(pre)) localStorage.removeItem(k);
      this.flat(p, v);
    },
    flat(p, v) {
      if (v === null || v === undefined) return;
      if (typeof v === 'object') { for (const k in v) this.flat(p + '/' + k, v[k]); }
      else localStorage.setItem(LP + p, JSON.stringify(v));
    },
    set(p, v) { this.writeRaw(p, v); this.notify(); return Promise.resolve(); },
    update(p, o) { for (const k in o) this.writeRaw(p + '/' + k, o[k]); this.notify(); return Promise.resolve(); },
    remove(p) { this.writeRaw(p, null); this.notify(); return Promise.resolve(); },
    get(p) { return Promise.resolve(this.read(p)); },
    txn(p, fn) {
      const cur = this.read(p); const nv = fn(cur);
      if (nv === undefined) return Promise.resolve({ committed: false, val: cur });
      this.writeRaw(p, nv); this.notify();
      return Promise.resolve({ committed: true, val: this.read(p) });
    },
    on(p, cb) { const L = { kind: 'v', p, cb }; this.listeners.add(L); setTimeout(() => this.fire(L), 0); return () => this.listeners.delete(L); },
    onTop(p, child, n, cb) { const L = { kind: 'top', p, child, n, cb }; this.listeners.add(L); setTimeout(() => this.fire(L), 0); return () => this.listeners.delete(L); },
    compute(L) {
      const v = this.read(L.p);
      if (L.kind === 'v') return v;
      return Object.entries(v || {})
        .filter(([, x]) => x && typeof x === 'object' && typeof x[L.child] === 'number')
        .map(([k, x]) => Object.assign({ key: k }, x))
        .sort((a, b) => b[L.child] - a[L.child]).slice(0, L.n);
    },
    fire(L) {
      if (!this.listeners.has(L)) return;
      const v = this.compute(L); const j = JSON.stringify(v);
      if (j === L.last) return; L.last = j;
      try { L.cb(v); } catch (e) { console.error(e); }
    },
    notify() {
      if (this.pending) return; this.pending = true;
      setTimeout(() => { this.pending = false; for (const L of this.listeners) this.fire(L); }, 16);
    },
    now() { return Date.now(); },
    onConnected(cb) { setTimeout(() => cb(true), 0); }
  };


  /* ───────── 工具 ───────── */
  function hash(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const toArr = x => Array.isArray(x) ? x.slice() : (x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]) : []);
  function hexRgb(h) { h = String(h || '#888').replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgba(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
  function shade(h, k) { const [r, g, b] = hexRgb(h); const f = v => Math.round(clamp(k > 0 ? v + (255 - v) * k : v * (1 + k), 0, 255)); return `rgb(${f(r)},${f(g)},${f(b)})`; }

  /* 桌號清單："1-8,VIP,主桌" → ['1',...,'8','VIP','主桌'] */
  function parseTables(str) {
    const out = [];
    String(str || '').split(/[,，、\s]+/).forEach(t => {
      t = t.trim(); if (!t) return;
      const m = t.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
      if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let i = a; i <= b && out.length < 300; i++) out.push(String(i)); }
      else out.push(t.slice(0, 10));
    });
    return [...new Set(out)];
  }
  const num = (v, d, a, b) => { v = +v; return isFinite(v) ? clamp(v, a, b) : d; };

  const GS = window.GS = {
    ROOT, DEFAULT_CFG, STAGES, LOCAL_MODE: !USE_FB, db: null, hash, clamp, rgba, shade, parseTables, toArr, TAU,
    HB_MS: 15000,          // 玩家心跳間隔
    ALIVE_MS: 45000,       // 多久沒心跳就不算在線
    LIGHT_MS: 700,         // 出站紅燈每顆間隔
    async ready() {
      const b = USE_FB ? FB : LOCAL;
      await b.init(); GS.db = b;
      if (!USE_FB) {
        const tag = document.createElement('div');
        tag.textContent = '本機測試模式';
        tag.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px sans-serif;color:#fff;background:rgba(200,30,60,.85);padding:3px 8px;border-radius:10px;pointer-events:none';
        document.body.appendChild(tag);
      }
      return b;
    },
    p(sub) { return ROOT + '/' + sub; },
    cleanName(n) { return String(n || '').replace(/[.#$\[\]\/\\<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10); },
    uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
    cfgOf(g) {
      const s = (g && g.cfg) || {}, D = DEFAULT_CFG;
      const c = Object.assign({}, D, s);
      c.need1 = num(s.need1, D.need1, 5, 500); c.need2 = num(s.need2, D.need2, 5, 800);
      c.need3 = num(s.need3, D.need3, 2, 60); c.win4 = num(s.win4, D.win4, 2, 20);
      c.grace = num(s.grace, D.grace, 3, 60); c.maxSec = num(s.maxSec, D.maxSec, 10, 180);
      c.swing = num(s.swing, D.swing, 3, 30); c.rate = num(s.rate, D.rate, 3, 20);
      c.wobble = num(s.wobble, D.wobble, 0.5, 15); c.cut = num(s.cut, D.cut, 0, 5);
      const ta = toArr(s.teams).filter(Boolean);
      c.teams = (ta.length ? ta : D.teams).slice(0, 8).map((t, i) => ({ n: String(t.n || ('第' + (i + 1) + '隊')).slice(0, 8), c: t.c || '#888888', tb: String(t.tb || '') }));
      c.title = String(c.title || D.title).slice(0, 12); c.brand = String(c.brand || D.brand).slice(0, 20);
      return c;
    },
    tableList(cfg) { return parseTables(cfg.tables); },
    /* 依桌號找隊伍；沒設定到的桌號依順序輪流分配 */
    teamOfTable(cfg, tb) {
      tb = String(tb);
      for (let i = 0; i < cfg.teams.length; i++) if (parseTables(cfg.teams[i].tb).includes(tb)) return i;
      const list = parseTables(cfg.tables), k = list.indexOf(tb);
      return Math.max(0, k) % Math.max(1, cfg.teams.length);
    },
    team(cfg, i) { return cfg.teams[i] || { n: '隊伍', c: '#888888' }; },

    /* 每關的「每人目標量」：搖晃關＝下數；加油關＝0.1 秒為單位 */
    need(cfg, s) { return s === 0 ? cfg.need1 : s === 1 ? cfg.need2 : s === 2 ? cfg.need3 * 10 : 0; },
    /* 每個人最多算多少（避免一個人扛全隊；人均仍可互補） */
    capOf(cfg, s) { return s < 3 ? GS.need(cfg, s) * 2 : Math.ceil(cfg.win4 * cfg.rate); },

    /* 依目前資料算出隊伍狀態（後台每 0.3 秒算一次） */
    teamStat(cfg, s, prog, players, mem) {
      const T = cfg.teams.length, sum = new Array(T).fill(0), cnt = new Array(T).fill(0), cap = GS.capOf(cfg, s);
      for (const pid in (prog || {})) {
        const v = +prog[pid] || 0, pl = players && players[pid];
        if (!pl || typeof pl.tm !== 'number' || pl.tm < 0 || pl.tm >= T) continue;
        sum[pl.tm] += clamp(v, 0, cap); if (v > 0) cnt[pl.tm]++;
      }
      const m = toArr(mem);
      return sum.map((x, i) => {
        const n = Math.max(1, +m[i] || 0, cnt[i]);
        const v = x / n;
        const p = s < 3 ? clamp(v / GS.need(cfg, s), 0, 1) : 0;
        return { n, v: Math.round(v * 10) / 10, p: Math.round(p * 1000) / 1000 };
      });
    },

    /* 一關結算：t＝[{p,v,d(完成時間戳)}]，回傳每隊 {time,v,p,done,pts,rank} */
    stageResult(cfg, s, st) {
      const t = toArr(st && st.t), start = (st && st.startAt) || 0, end = (st && st.endAt) || start;
      const T = cfg.teams.length, out = [];
      for (let i = 0; i < T; i++) {
        const x = t[i] || { p: 0, v: 0 };
        if (s < 3) {
          let time;
          const el = Math.max(0, (end - start) / 1000);
          if (x.d) time = (x.d - start) / 1000;
          else time = x.p > 0.02 ? Math.min(el / x.p, el + 30) : el + 30;   // 沒完成：照目前速度推算
          out.push({ time: Math.round(time * 10) / 10, v: x.v || 0, p: x.p || 0, done: !!x.d });
        } else out.push({ time: 0, v: x.v || 0, p: 0, done: true });
      }
      if (s < 3) {
        const best = Math.min(...out.map(o => o.time));
        out.forEach(o => { o.pts = Math.max(1, 10 - Math.floor(o.time - best + 1e-6)); });
        out.forEach(o => { o.rank = 1 + out.filter(x => x.time < o.time).length; });   // 同秒數同名次
      } else {
        const vmax = Math.max(0, ...out.map(o => o.v));
        out.forEach(o => { o.pts = vmax > 0 ? Math.max(1, Math.round(10 * o.v / vmax)) : 1; });
        out.forEach(o => { o.rank = 1 + out.filter(x => x.v > o.v).length; });
      }
      return out;
    },

    /* 總分：依總分 → 前三關總時間 → 出站下數 排名 */
    totals(cfg, resAll) {
      const T = cfg.teams.length, R = toArr(resAll);
      const out = [];
      for (let i = 0; i < T; i++) {
        const st = [0, 1, 2, 3].map(s => { const r = R[s] && toArr(R[s].t)[i]; return r ? r.pts : null; });
        let time = 0, v4 = 0;
        [0, 1, 2].forEach(s => { const r = R[s] && toArr(R[s].t)[i]; if (r) time += r.time; });
        const r4 = R[3] && toArr(R[3].t)[i]; if (r4) v4 = r4.v;
        out.push({ i, st, pts: st.reduce((a, b) => a + (b || 0), 0), time: Math.round(time * 10) / 10, v4 });
      }
      const ord = out.slice().sort((a, b) => b.pts - a.pts || a.time - b.time || b.v4 - a.v4);
      ord.forEach((o, k) => o.rank = k + 1);
      return { list: out, order: ord.map(o => o.i), done: R.filter(Boolean).length };
    },
    fmtT(sec) { if (!isFinite(sec)) return '--'; return sec.toFixed(1) + 's'; }
  };

  /* ═════════════ 動作偵測（玩家端） ═════════════
     mode：motion＝手機感應器｜tap＝點擊模式（偵測不到時的備案）
     鍵盤（電腦測試）：空白鍵＝搖一下，按住 S＝拿穩 */
  GS.Motion = function (getCfg) {
    const M = {
      mode: 'none', saw: false, shakes: 0, onShake: null,
      grav: null, lin: 0, wobAt: 0, upright: true, held: false, keyHeld: false,
      tokens: 10, lastTok: performance.now(), dir: null, strongAt: 0, lastShake: 0, peak: 0, peakAt: 0, src: '',
      async request() {
        try {
          if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
            const r = await DeviceMotionEvent.requestPermission();
            if (r !== 'granted') return 'denied';
          }
        } catch (e) { return 'denied'; }
        if (!M._on) { window.addEventListener('devicemotion', M.handle, { passive: true }); M._on = true; }
        return 'ok';
      },
      token(now) {
        const c = getCfg(); const r = c.rate;
        M.tokens = Math.min(r, M.tokens + (now - M.lastTok) / 1000 * r); M.lastTok = now;
        if (M.tokens >= 1) { M.tokens -= 1; return true; }
        return false;
      },
      shake(src) {
        const now = performance.now();
        if (!M.token(now)) return;
        M.shakes++; M.lastShake = now;
        if (M.onShake) M.onShake(src);
      },
      handle(e) {
        const g = e.accelerationIncludingGravity, a = e.acceleration;
        const ok = v => v && v.x != null && isFinite(v.x);
        if (!ok(g) && !ok(a)) return;
        M.saw = true; if (M.mode !== 'motion') M.mode = 'motion';
        const now = performance.now(), c = getCfg();
        let lx, ly, lz;
        if (ok(g)) {
          if (!M.grav) M.grav = { x: g.x, y: g.y, z: g.z || 0 };
          const k = 0.1; M.grav.x += (g.x - M.grav.x) * k; M.grav.y += (g.y - M.grav.y) * k; M.grav.z += ((g.z || 0) - M.grav.z) * k;
          const gm = Math.hypot(M.grav.x, M.grav.y, M.grav.z) || 9.8;
          M.upright = Math.abs(M.grav.z) < 0.6 * gm;    // 手機直立（不是平放在桌上）
        }
        if (ok(a)) { lx = a.x; ly = a.y; lz = a.z || 0; M.src = 'a'; }
        else { lx = g.x - M.grav.x; ly = g.y - M.grav.y; lz = (g.z || 0) - M.grav.z; M.src = 'g'; }
        const mag = Math.hypot(lx, ly, lz); M.lin = mag;
        if (mag > c.wobble) M.wobAt = now;
        /* 甩動判定（不分方向）：手機往某個方向甩、力道超過門檻，接著往「相反方向」也超過門檻＝算一下
           不管手機怎麼拿、往哪個方向甩都可以；輕晃、慢慢移動都不會算 */
        if (now - M.strongAt > 600) M.dir = null;
        const T = c.swing;
        if (now - M.peakAt > 1000) { M.peak = 0; M.peakAt = now; }
        if (mag > M.peak) M.peak = mag;
        let rev = false;
        if (mag > T) {
          const u = [lx / mag, ly / mag, lz / mag];
          if (M.dir && u[0] * M.dir[0] + u[1] * M.dir[1] + u[2] * M.dir[2] < -0.3) rev = true;
          M.dir = u; M.strongAt = now;
        }
        if (rev && now - M.lastShake > 80) M.shake('m');
      },
      /* 拿穩判定：感應器＝直立且沒有大晃動；點擊模式＝手指按住 */
      steady(now) {
        if (M.keyHeld) return 'ok';
        if (M.mode === 'motion') { if (!M.upright) return 'flat'; return now - M.wobAt < 120 ? 'wobble' : 'ok'; }
        return M.held ? 'ok' : 'off';
      },
      bindTap(el) {
        el.addEventListener('pointerdown', e => { M.held = true; if (M.mode !== 'motion') M.shake('t'); });
        const up = () => { M.held = false; };
        el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', up);
      },
      bindKeys() {
        window.addEventListener('keydown', e => {
          if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
          if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) M.shake('k'); }
          if (e.code === 'KeyS') M.keyHeld = true;
        });
        window.addEventListener('keyup', e => { if (e.code === 'KeyS') M.keyHeld = false; });
      }
    };
    M.handle = M.handle.bind(M);
    return M;
  };

  /* ═════════════ 車輛側面圖（投影用） ═════════════
     x,y＝車子正下方地面中心；s＝縮放（s=1 時車長約 300px）
     o: { lift, rear:'old'|'new'|'off'|'work', front:同上, spin, flame, num } */
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  GS.rr = rr;
  function wheel(c, x, y, r, kind, spin, col) {
    if (kind === 'off') return;
    c.save(); c.translate(x, y);
    c.fillStyle = kind === 'old' ? '#3a3a42' : '#0b0b0f';
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
    c.strokeStyle = kind === 'old' ? '#55555e' : '#1d1d24'; c.lineWidth = r * 0.08;
    c.beginPath(); c.arc(0, 0, r * 0.86, 0, TAU); c.stroke();
    if (kind !== 'old') { c.strokeStyle = col; c.lineWidth = r * 0.07; c.beginPath(); c.arc(0, 0, r * 0.72, 0, TAU); c.stroke(); }
    c.fillStyle = kind === 'old' ? '#77777f' : '#c9ccd6';
    c.beginPath(); c.arc(0, 0, r * 0.55, 0, TAU); c.fill();
    c.rotate(spin || 0); c.strokeStyle = kind === 'old' ? '#55555c' : '#6b6f7c'; c.lineWidth = r * 0.12;
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; c.beginPath(); c.moveTo(Math.cos(a) * r * 0.14, Math.sin(a) * r * 0.14); c.lineTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5); c.stroke(); }
    c.fillStyle = kind === 'old' ? '#444' : col; c.beginPath(); c.arc(0, 0, r * 0.13, 0, TAU); c.fill();
    c.restore();
  }
  GS.drawCar = function (c, x, y, s, col, o) {
    o = o || {};
    const R = 34, lift = o.lift || 0, dark = shade(col, -0.45), lite = shade(col, 0.3);
    c.save(); c.translate(x, y); c.scale(s, s);
    /* 影子 */
    c.fillStyle = 'rgba(0,0,0,.45)'; c.beginPath(); c.ellipse(0, 2, 160, 10, 0, 0, TAU); c.fill();
    const by = -lift;   // 車身離地
    const wy = by - R;  // 輪心
    /* 尾焰 */
    if (o.flame > 0.05) {
      const f = o.flame, L = 50 + 90 * f * (0.8 + 0.4 * Math.random());
      const gr = c.createLinearGradient(-150, 0, -150 - L, 0);
      gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(0.25, 'rgba(255,214,10,.9)'); gr.addColorStop(0.7, 'rgba(255,90,20,.6)'); gr.addColorStop(1, 'rgba(255,40,0,0)');
      c.fillStyle = gr; c.beginPath(); c.moveTo(-148, by - 66); c.lineTo(-150 - L, by - 58); c.lineTo(-148, by - 50); c.fill();
    }
    /* 尾翼 */
    c.fillStyle = '#16161d'; c.fillRect(-152, by - 112, 18, 64);
    c.fillStyle = col; c.fillRect(-160, by - 116, 40, 12); c.fillStyle = dark; c.fillRect(-158, by - 100, 34, 7);
    /* 車身 */
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(-140, by - 30); c.lineTo(-140, by - 66);
    c.quadraticCurveTo(-80, by - 72, -46, by - 92);    // 引擎蓋
    c.lineTo(-30, by - 96); c.lineTo(-14, by - 70);
    c.lineTo(60, by - 62); c.quadraticCurveTo(120, by - 52, 158, by - 34);   // 鼻錐
    c.lineTo(158, by - 26); c.lineTo(60, by - 24); c.lineTo(-140, by - 24); c.closePath(); c.fill();
    /* 側箱暗面、亮線 */
    c.fillStyle = dark; c.beginPath(); c.moveTo(-120, by - 26); c.lineTo(-110, by - 52); c.lineTo(40, by - 50); c.lineTo(52, by - 26); c.closePath(); c.fill();
    c.strokeStyle = lite; c.lineWidth = 3; c.beginPath(); c.moveTo(-134, by - 64); c.quadraticCurveTo(-80, by - 70, -48, by - 88); c.stroke();
    c.fillStyle = '#111'; c.fillRect(-140, by - 26, 300, 6);     // 底板
    /* 前翼 */
    c.fillStyle = '#16161d'; c.fillRect(112, by - 20, 52, 6); c.fillStyle = col; c.fillRect(118, by - 28, 46, 6);
    /* 號碼 */
    c.fillStyle = '#fff'; c.beginPath(); c.arc(-22, by - 40, 15, 0, TAU); c.fill();
    c.fillStyle = '#111'; c.font = '900 18px Orbitron, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(o.num || 1), -22, by - 39);
    /* 座艙、安全帽、Halo */
    c.fillStyle = '#0b0b10'; rr(c, -14, by - 82, 58, 18, 8); c.fill();
    c.fillStyle = '#f2f2f5'; c.beginPath(); c.arc(8, by - 82, 14, 0, TAU); c.fill();
    c.fillStyle = col; c.fillRect(-4, by - 90, 24, 6);
    c.fillStyle = '#1a2a3a'; c.fillRect(8, by - 86, 14, 6);
    c.strokeStyle = '#2b2b33'; c.lineWidth = 5; c.beginPath(); c.moveTo(-10, by - 72); c.quadraticCurveTo(14, by - 104, 44, by - 70); c.stroke();
    /* 輪胎 */
    wheel(c, -95, wy, R, o.rear || 'new', o.spin, col);
    wheel(c, 98, wy, R, o.front || 'new', o.spin, col);
    c.restore();
  };
  GS.wheel = wheel;
})();
