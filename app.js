"use strict";

const CFG = window.MON_CFG || {};
const API = (CFG.api || "https://api.github.com").replace(/\/$/, "");
const TOKEN_KEY = "potc.live.token";
const CACHE_KEY = "potc.live.now";
const POLL_MS = Math.max(5, CFG.poll || 15) * 1000;
const FETCH_TIMEOUT_MS = 15000;
const TREND_CACHE_KEY = "potc.live.trend";
const MAINT = new Set(["----", "BLOCKED", "NotConnect", "Maintenance"]);
const BAD_FLAGS = { server_down: "서버 끊김", agent_down: "에이전트 끊김", frame_stop: "프레임 정지" };
const WARN_FLAGS = { high_dispatch: "처리 대기 적체" };
const MACHINE_FLAGS = { cpu: "CPU 95%+", net: "네트워크 95%+", mem: "메모리 부족", drive: "디스크 부족", stale: "정보 끊김" };
const LEVEL_KO = { ok: "정상", warn: "주의", bad: "이상", maint: "점검" };
const SEV_KO = { err: "오류", warn: "경고", ok: "복구", info: "정보" };

const state = {
  now: null, trend: null, mtrend: null, events: null, hist: null,
  at: { now: 0, trend: 0, mtrend: 0, events: 0, hist: 0 },
  tab: "sum", sort: "state", q: "", evf: "all", detail: null, err: null, rlUntil: 0, busy: false, scrub: null, pendingRender: false, pin: null, down: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 0) => (v == null || isNaN(v) ? "-" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ep) => { if (!ep) return "-"; const d = new Date(ep * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mdhm = (ep) => { if (!ep) return "-"; const d = new Date(ep * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ep)}`; };

function store(key, val) {
  try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) { }
}
function recall(key) {
  try { return localStorage.getItem(key) || ""; } catch (e) { return ""; }
}

class AuthError extends Error { }

const NAME_KEY = "potc.live.name";
const ACC_KEY = "potc.live.acc";
const ACC_GAP = 600;
const ACC_EVERY = 120;
const acc = { id: null, start: 0, vis: 0, tabs: {}, seenAt: 0, sentAt: 0, last: 0, busy: false, off: null, fp: null };
try { const a = JSON.parse(recall(ACC_KEY) || "null"); if (a && Date.now() / 1000 - a.last < ACC_GAP) Object.assign(acc, { id: a.id, start: a.start, vis: a.vis, tabs: a.tabs || {}, last: a.last }); } catch (e) { }

async function tokenFp() {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recall(TOKEN_KEY)));
  return [...new Uint8Array(b)].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function devName() {
  const u = navigator.userAgent;
  const os = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac/.test(u) ? "Mac" : "기타";
  const br = /Edg/.test(u) ? "Edge" : /SamsungBrowser/.test(u) ? "삼성 인터넷" : /CriOS|Chrome/.test(u) ? "Chrome" : /FxiOS|Firefox/.test(u) ? "Firefox" : /Safari/.test(u) ? "Safari" : "";
  const app = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone ? " 홈 화면 앱" : "";
  return `${os} ${br}${app}`.trim();
}
function accCount() {
  const now = Date.now() / 1000;
  if (!document.hidden && acc.seenAt) {
    const d = Math.min(now - acc.seenAt, 30);
    acc.vis += d;
    acc.tabs[state.tab] = (acc.tabs[state.tab] || 0) + d;
  }
  acc.seenAt = document.hidden ? 0 : now;
  acc.last = now;
}
function accSave() {
  store(ACC_KEY, JSON.stringify({ id: acc.id, start: acc.start, vis: acc.vis, tabs: acc.tabs, last: acc.last }));
}
function accReset() {
  Object.assign(acc, { id: null, start: 0, vis: 0, tabs: {}, sentAt: 0 });
  store(ACC_KEY, null);
}
async function accSync(force, keepalive) {
  const issue = state.now && state.now.access_issue;
  if (acc.off || acc.busy || !issue || !recall(TOKEN_KEY) || !window.crypto || !crypto.subtle) return;
  accCount();
  if (!force && acc.id && acc.last - acc.sentAt < ACC_EVERY) return;
  acc.busy = true;
  try {
    if (!acc.fp) acc.fp = await tokenFp();
    const body = "potc-access " + JSON.stringify({ v: 1, fp: acc.fp, name: recall(NAME_KEY), dev: devName(), vis: Math.round(acc.vis),
      tabs: Object.entries(acc.tabs).map(([k, v]) => [k, Math.round(v)]) });
    const base = `${API}/repos/${CFG.owner}/${CFG.repo}`;
    const headers = { Authorization: `Bearer ${recall(TOKEN_KEY)}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
    let r = acc.id ? await fetch(`${base}/issues/comments/${acc.id}`, { method: "PATCH", headers, keepalive: !!keepalive, body: JSON.stringify({ body }) }) : null;
    if (r && r.status === 404) { acc.id = null; r = null; }
    if (!r) {
      r = await fetch(`${base}/issues/${issue}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
      if (r.ok) { acc.id = (await r.json()).id; acc.start = acc.last; }
    }
    if (r.status === 403 || r.status === 404) acc.off = "이 토큰에는 접속 기록(Issues) 권한이 없어 기록이 남지 않습니다.";
    else if (r.ok) { acc.sentAt = acc.last; accSave(); }
  } catch (e) {
  } finally {
    acc.busy = false;
  }
}

async function load(file) {
  if (Date.now() < state.rlUntil) throw new Error(`요청 한도 초과, ${hhmm(state.rlUntil / 1000)} 이후 재개`);
  const url = `${API}/repos/${CFG.owner}/${CFG.repo}/contents/${file}?ref=${encodeURIComponent(CFG.branch || "live")}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, {
      cache: "no-cache", signal: ctl.signal,
      headers: { Authorization: `Bearer ${recall(TOKEN_KEY)}`, Accept: "application/vnd.github.raw+json" },
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `${file}: ${FETCH_TIMEOUT_MS / 1000}초 안에 응답 없음` : `${file}: 연결 실패`);
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 403 && r.headers.get("X-RateLimit-Remaining") === "0") {
    state.rlUntil = (parseInt(r.headers.get("X-RateLimit-Reset") || "0", 10) * 1000) || Date.now() + 300000;
    throw new Error(`요청 한도 초과, ${hhmm(state.rlUntil / 1000)} 이후 재개`);
  }
  if (r.status === 401) throw new AuthError("토큰이 맞지 않거나 만료됐습니다.");
  if (r.status === 404 || r.status === 403) throw new AuthError("이 토큰으로 데이터 저장소를 읽을 수 없습니다.");
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return r.json();
}

function serverLevel(s) {
  const f = s.flags || [];
  if (s.type === "GS" && MAINT.has(s.cond)) return "maint";
  if (s.state === "off" || f.some((x) => BAD_FLAGS[x])) return "bad";
  if (f.some((x) => WARN_FLAGS[x]) || (s.type === "GS" && s.fps != null && s.fps < 30)) return "warn";
  return "ok";
}

function serverIssues(s) {
  const out = (s.flags || []).map((x) => BAD_FLAGS[x] || WARN_FLAGS[x] || x);
  if (s.state === "off" && !out.length) out.push("꺼짐");
  if (s.type === "GS" && s.fps != null && s.fps < 30) out.push(`FPS ${num(s.fps, 1)}`);
  return out;
}

function totalSeries(trend) {
  if (!trend || !trend.servers) return null;
  const n = trend.slots;
  const out = new Array(n).fill(null);
  for (const s of Object.values(trend.servers)) {
    (s.users || []).forEach((v, i) => {
      if (v == null) return;
      const k = s.o + i;
      out[k] = (out[k] || 0) + v;
    });
  }
  return out;
}

function serverSeries(trend, svid, field) {
  const n = trend ? trend.slots : 0;
  const out = new Array(n).fill(null);
  const s = trend && trend.servers && trend.servers[svid];
  if (s && s[field]) s[field].forEach((v, i) => { out[s.o + i] = v; });
  return out;
}

function lastIndex(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
  return -1;
}

function chart(series, opt = {}) {
  const W = 300, H = opt.h || 90, L = 30, B = 14, T = 6;
  const n = Math.max(...series.map((s) => s.vals.length), 1);
  let max = opt.max != null ? opt.max : 0;
  let min = opt.min != null ? opt.min : Infinity;
  for (const s of series) for (const v of s.vals) if (v != null) { max = Math.max(max, v); min = Math.min(min, v); }
  if (min === Infinity) min = 0;
  if (opt.zero !== false) min = Math.min(min, 0);
  if (max <= min) max = min + 1;
  const x = (i) => L + (i / Math.max(n - 1, 1)) * (W - L - 2);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const paths = series.map((s) => {
    let d = "", pen = false;
    s.vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path class="${s.cls}" d="${d}"/>`;
  }).join("");
  const ticks = (opt.ticks || []).map((t) => `<text x="${x(t.i).toFixed(1)}" y="${H - 2}" text-anchor="${t.i >= n - 1 ? "end" : "middle"}">${esc(t.label)}</text>`).join("");
  const fmt = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : num(v, max - min < 10 ? 1 : 0));
  const cid = CHARTS.size + 1;
  CHARTS.set(cid, { series, n, x, y, time: opt.time, digits: opt.digits || 0, unit: opt.unit || "" });
  const dots = series.map((s) => `<circle class="${s.cls}" r="3"/>`).join("");
  return `<div class="chartwrap" data-cid="${cid}"><div class="readout"></div><svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    <line class="axis" x1="${L}" y1="${y(min)}" x2="${W}" y2="${y(min)}"/>
    <line class="axis" x1="${L}" y1="${y(max)}" x2="${W}" y2="${y(max)}"/>
    <text x="${L - 4}" y="${y(max) + 3}" text-anchor="end">${fmt(max)}</text>
    <text x="${L - 4}" y="${y(min) + 3}" text-anchor="end">${fmt(min)}</text>
    ${paths}${ticks}<g class="scrub" visibility="hidden"><line class="sline" y1="${T}" y2="${H - B}"/>${dots}</g></svg></div>`;
}

const CHARTS = new Map();

const slotTime = (bucket) => (i) => { const m = Math.round((i * (bucket || 300)) / 60); return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; };

function wrapRef(wrap) {
  const area = wrap.closest("#sheet") ? "sheet" : "view";
  const all = [...document.querySelectorAll(`#${area} .chartwrap`)];
  return { area, idx: all.indexOf(wrap), ctx: area === "sheet" ? `d${state.detail}` : state.tab };
}

function pinnedWrap() {
  const p = state.pin;
  if (!p || p.ctx !== (p.area === "sheet" ? `d${state.detail}` : state.tab)) return null;
  return document.querySelectorAll(`#${p.area} .chartwrap`)[p.idx] || null;
}

function hideAt(wrap) {
  const g = wrap && wrap.querySelector(".scrub");
  if (g) g.setAttribute("visibility", "hidden");
  const ro = wrap && wrap.querySelector(".readout");
  if (ro) ro.classList.remove("on");
}

function clearPin() {
  hideAt(pinnedWrap());
  state.pin = null;
}

function applyPin() {
  const wrap = pinnedWrap();
  const c = wrap && CHARTS.get(Number(wrap.dataset.cid));
  if (c) showAt(wrap, Math.min(state.pin.i, c.n - 1));
}

function scrubAt(wrap, clientX) {
  const c = CHARTS.get(Number(wrap.dataset.cid));
  if (!c) return;
  const rect = wrap.querySelector("svg").getBoundingClientRect();
  const vx = ((clientX - rect.left) / rect.width) * 300;
  let i = Math.round(((vx - c.x(0)) / (c.x(c.n - 1) - c.x(0) || 1)) * (c.n - 1));
  i = Math.max(0, Math.min(c.n - 1, i));
  const prev = pinnedWrap();
  if (prev && prev !== wrap) hideAt(prev);
  state.pin = { ...wrapRef(wrap), i };
  showAt(wrap, i);
}

function showAt(wrap, i) {
  const c = CHARTS.get(Number(wrap.dataset.cid));
  if (!c) return;
  const svg = wrap.querySelector("svg");
  const g = svg.querySelector(".scrub");
  g.setAttribute("visibility", "visible");
  const line = g.querySelector(".sline");
  line.setAttribute("x1", c.x(i));
  line.setAttribute("x2", c.x(i));
  const parts = [];
  g.querySelectorAll("circle").forEach((dot, k) => {
    const s = c.series[k], v = s.vals[i];
    if (v == null) { dot.setAttribute("visibility", "hidden"); return; }
    dot.setAttribute("visibility", "visible");
    dot.setAttribute("cx", c.x(i));
    dot.setAttribute("cy", c.y(v));
    parts.push(`<span><i style="background:var(--${s.cls === "s2" ? "c2" : s.cls === "s3" ? "c3" : "c1"})"></i>${esc(s.name || "")} <b>${num(v, c.digits)}${esc(c.unit)}</b></span>`);
  });
  const ro = wrap.querySelector(".readout");
  ro.innerHTML = `<span class="t">${esc(c.time ? c.time(i) : String(i))}</span>${parts.join("") || '<span class="muted">기록 없음</span>'}`;
  ro.classList.add("on");
}

function scrubEnd(e) {
  const down = state.down;
  state.down = null;
  if (!state.scrub && down && e && e.type === "pointerup" && !down.onChart &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) clearPin();
  state.scrub = null;
  if (state.pendingRender) { state.pendingRender = false; render(); }
}

function dayTicks(trend) {
  const per = 3600 / ((trend && trend.bucket) || 300);
  return [0, 6, 12, 18, 24].map((h) => ({ i: Math.min(h * per, (trend ? trend.slots : 288) - 1), label: `${h}시` }));
}

function legend(items) {
  return `<div class="legend">${items.map(([cls, label]) => `<span><i style="background:var(--${cls})"></i>${esc(label)}</span>`).join("")}</div>`;
}

const ICON = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3"/>',
  server: '<rect x="4" y="4" width="16" height="6.5" rx="2"/><rect x="4" y="13.5" width="16" height="6.5" rx="2"/>',
  gauge: '<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 13l4-4"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 2.5v4M14.5 2.5v4M9.5 17.5v4M14.5 17.5v4M2.5 9.5h4M2.5 14.5h4M17.5 9.5h4M17.5 14.5h4"/>',
};
const ic = (name) => `<svg class="ic" viewBox="0 0 24 24">${ICON[name] || ""}</svg>`;

function hourStrip(series, bucket, live) {
  if (!series) return "";
  const per = Math.round(3600 / (bucket || 300));
  const last = lastIndex(series);
  if (last < 0) return "";
  const nowH = Math.floor(last / per);
  const hours = [];
  for (let h = 0; h <= nowH; h++) {
    const vals = series.slice(h * per, (h + 1) * per).filter((v) => v != null);
    if (!vals.length) continue;
    hours.push({ h, v: h === nowH && live != null ? live : Math.max(...vals) });
  }
  const max = Math.max(...hours.map((x) => x.v), 1);
  const min = Math.min(...hours.map((x) => x.v));
  const pct = (v) => (max > min ? 18 + 82 * ((v - min) / (max - min)) : 100);
  return `<div class="hours" id="hours">${hours.map((x) => `<div class="hour${x.h === nowH ? " now" : ""}">
      <span class="h">${x.h === nowH ? "지금" : `${x.h}시`}</span>
      <span class="b"><i style="height:${Math.round(pct(x.v))}%"></i></span>
      <span class="v">${x.v >= 10000 ? (x.v / 1000).toFixed(1) + "k" : num(x.v)}</span></div>`).join("")}</div>`;
}

function lastOf(trend, svid, field) {
  const s = trend && trend.servers && trend.servers[svid];
  const vals = s && s[field];
  if (!vals) return null;
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i];
  return null;
}

const ZONE_KO = { main: "일반", end: "바다의끝", death: "죽음의바다" };
const zoneOf = (s) => s.zone || (s.svid >= 700 && s.svid < 800 ? "end" : s.svid >= 800 && s.svid < 1000 ? "death" : "main");

function rankTile(icon, title, list, pick, digits, order, unit) {
  const rows = list.map((s) => ({ s, v: pick(s) })).filter((x) => x.v != null)
    .sort((a, b) => (order === "asc" ? a.v - b.v : b.v - a.v)).slice(0, 3);
  const items = rows.map((x) => `<li data-svid="${x.s.svid}"><span class="rn">${esc(x.s.svid)}</span><span class="rs">${esc(x.s.agent || "")}</span><b>${num(x.v, digits)}${unit}</b></li>`).join("");
  return `<div class="tile glass rank"><div class="k">${ic(icon)}${esc(title)}</div><ul>${items || `<li class="muted">기록 없음</li>`}</ul></div>`;
}

function renderSummary() {
  const now = state.now;
  if (!now) return `<div class="empty">데이터를 불러오는 중입니다</div>`;
  const t = now.totals || {};
  const today = state.trend && state.trend.today;
  const yest = state.trend && state.trend.yesterday;
  const tSeries = totalSeries(today);
  const ySeries = totalSeries(yest);
  let cmp = "";
  if (tSeries && ySeries) {
    const i = lastIndex(tSeries);
    const yv = i >= 0 ? ySeries[i] : null;
    if (yv) {
      const diff = (t.users || 0) - yv;
      cmp = `어제 이 시각 <span class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : ""}${num(diff)}</span>`;
    }
  }
  const gs = (now.servers || []).filter((s) => s.type === "GS" && s.state === "on" && !MAINT.has(s.cond) && zoneOf(s) === "main");
  const zones = ["end", "death"].map((z) => [z, (t.zones || {})[z]]).filter(([, v]) => v && v.servers);
  const memTop = (now.machines || []).map((m) => ({ name: m.name, pct: m.mem_total_gb && m.mem_free_gb != null ? ((m.mem_total_gb - m.mem_free_gb) / m.mem_total_gb) * 100 : null }))
    .filter((m) => m.pct != null).sort((a, b) => b.pct - a.pct)[0];
  const issues = [];
  for (const s of now.servers || []) {
    const lv = serverLevel(s);
    if (lv === "bad" || lv === "warn") issues.push({ lv, svid: s.svid, text: `${s.name}: ${serverIssues(s).join(", ")}` });
  }
  for (const m of now.machines || []) {
    if ((m.flags || []).length) issues.push({ lv: "warn", text: `${m.name}: ${m.flags.map((f) => MACHINE_FLAGS[f] || f).join(", ")}` });
  }
  const incidents = (now.incidents || []).map((x) => `<li><span class="muted">${hhmm(x.created)}</span>
      <span>${esc(x.conclusion || (x.status === "done" ? "결론 없음" : "분석 중"))}
      <span class="sub">${esc((x.subjects || []).map((s) => s.target).join(", "))}</span></span></li>`).join("");
  const fpsPos = t.fps_min == null ? null : Math.max(0, Math.min(100, (t.fps_min / 150) * 100));
  const tile = (icon, k, v, sub, extra = "") => `<div class="tile glass"><div class="k">${ic(icon)}${esc(k)}</div><div class="v">${v}</div>${extra}<div class="s">${sub}</div></div>`;
  return `
    <section class="hero">
      <div class="place">POTC 라이브</div>
      <div class="temp">${num(t.users)}</div>
      <div class="cond">${LEVEL_KO[now.level] || "-"} · 서버 ${num(t.servers_on)}/${num(t.servers)}</div>
      <div class="hl">최고 ${num(t.peak)}${cmp ? ` · ${cmp}` : ""}</div>
    </section>
    ${issues.length ? `<div class="card glass"><h3>${ic("alert")}경보<span class="right">${issues.length}건</span></h3><ul class="list">${issues.map((x) => `<li${x.svid != null ? ` data-svid="${x.svid}"` : ""}><span class="tag t-${x.lv}">${x.lv === "bad" ? "이상" : "주의"}</span><span>${esc(x.text)}</span></li>`).join("")}</ul></div>` : ""}
    ${incidents ? `<div class="card glass"><h3>${ic("spark")}경보 분석<span class="right">최근 6시간</span></h3><ul class="list">${incidents}</ul></div>` : ""}
    ${tSeries ? `<div class="card glass"><h3>${ic("clock")}시간별 접속자</h3>${issues.length ? "" : `<p class="note">현재 경보가 없습니다.</p>`}${hourStrip(tSeries, today.bucket, t.users)}</div>
    <div class="card glass"><h3>${ic("chart")}오늘 접속자 추이</h3>${chart([{ vals: ySeries || [], cls: "s2", name: "어제" }, { vals: tSeries, cls: "s1", name: "오늘" }], { ticks: dayTicks(today), time: slotTime(today.bucket), unit: "명" })}${legend([["c1", "오늘"], ["c2", "어제"]])}</div>` : `<div class="card glass"><h3>${ic("clock")}시간별 접속자</h3><p class="note">추이를 불러오는 중입니다. 수집기를 다시 시작한 직후라면 몇 분 걸립니다.</p></div>`}
    <div class="tiles">
      ${tile("server", "서버", `${num(t.servers_on)}<span class="sub">/${num(t.servers)}</span>`, `주의 ${num(t.warn)} · 이상 ${num(t.bad)}`)}
      ${tile("gauge", "FPS 평균 (일반)", num(t.fps_avg, 1), `최저 ${num(t.fps_min, 1)}`, fpsPos == null ? "" : `<div class="meter"><i style="left:${fpsPos}%"></i></div>`)}
      ${zones.length ? `<div class="tile glass rank wide"><div class="k">${ic("server")}바다의끝 · 죽음의바다</div><ul>${zones.map(([z, v]) => `<li data-zone="${z}"><span class="rn zn">${ZONE_KO[z]}</span><span class="rs">${num(v.servers_on)}/${num(v.servers)}대 · ${num(v.users)}명</span><b>${num(v.fps_avg, 0)}fps</b></li>`).join("")}</ul></div>` : ""}
      ${rankTile("gauge", "FPS 낮은 서버", gs, (s) => s.fps, 1, "asc", "")}
      ${rankTile("chip", "CPU 5분 평균", gs, (s) => lastOf(today, s.svid, "cpu"), 0, "desc", "%")}
      ${rankTile("db", "DB 대기 비중 (D)", gs, (s) => s.wusd && s.wusd.d, 1, "desc", "%")}
      ${tile("server", "장비", num(t.machines), `주의 ${num(t.machines_warn)}${memTop ? ` · 메모리 최고 ${esc(memTop.name)} ${num(memTop.pct, 0)}%` : ""}`)}
    </div>
    <div class="foot">${recall(NAME_KEY) ? `<span class="muted">${esc(recall(NAME_KEY))}</span> · ` : ""}<button class="link" data-act="forget">이 기기에서 토큰 지우기</button>${acc.off ? `<p class="muted">${esc(acc.off)}</p>` : ""}</div>`;
}

const SKY_TOP = { "ok-day": "#2a72cf", "ok-dusk": "#33407e", "ok-night": "#070f24", "warn-day": "#8a5a22", "warn-night": "#20160d",
  "bad-day": "#1f2229", "bad-night": "#1f2229", "maint-day": "#231c48", "maint-night": "#231c48" };

function skyOf(level) {
  const h = new Date().getHours();
  const part = h >= 7 && h < 17 ? "day" : h >= 17 && h < 19 ? "dusk" : "night";
  const lv = ["warn", "bad", "maint"].includes(level) ? level : "ok";
  return lv === "ok" ? `ok-${part}` : `${lv}-${part === "day" ? "day" : "night"}`;
}

function sortServers(list) {
  const rank = { bad: 0, warn: 1, maint: 2, ok: 3 };
  const by = {
    state: (a, b) => rank[serverLevel(a)] - rank[serverLevel(b)] || (b.ccu || 0) - (a.ccu || 0),
    ccu: (a, b) => (b.ccu || 0) - (a.ccu || 0),
    fps: (a, b) => (a.fps == null ? 1e9 : a.fps) - (b.fps == null ? 1e9 : b.fps),
    num: (a, b) => (a.svid || 0) - (b.svid || 0),
  }[state.sort];
  return list.slice().sort(by);
}

function wusdBar(w) {
  if (!w) return "";
  return `<div class="wusd">${["w", "u", "s", "d"].map((k) => `<span class="w-${k}" style="width:${Math.max(0, w[k] || 0)}%"></span>`).join("")}</div>`;
}

function renderServers() {
  const now = state.now;
  if (!now) return `<div class="empty">데이터를 불러오는 중입니다</div>`;
  const q = state.q.trim().toLowerCase();
  const hit = (now.servers || []).filter((s) => !q || `${s.svid} ${s.name} ${s.agent} ${s.type}`.toLowerCase().includes(q));
  const gsHit = hit.filter((s) => s.type === "GS");
  const others = hit.filter((s) => s.type !== "GS")
    .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.agent).localeCompare(String(b.agent)));
  const otherRows = others.map((s) => {
    const lv = serverLevel(s);
    return `<li><span class="dot ${lv}"></span><span class="oname">${esc(s.type)}</span><span class="muted">${esc(s.agent)}</span>
      <span class="ostate t-${lv}">${lv === "bad" ? esc(serverIssues(s).join(", ") || "꺼짐") : "켜짐"}</span></li>`;
  }).join("");
  const row = (s) => {
    const lv = serverLevel(s);
    const iss = serverIssues(s);
    return `<div class="srv" data-svid="${s.svid}">
      <span class="dot ${lv}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="nums">${num(s.ccu)}명 · ${num(s.fps, 0)}fps · ${s.cpu == null ? "-" : num(s.cpu, 0) + "%"}</span>
      <span class="meta">${esc(s.type)} · ${esc(s.agent)} · ${esc(s.cond || "-")}${iss.length ? ` · <b class="t-${lv}">${esc(iss.join(", "))}</b>` : ""}${s.type === "GS" ? wusdBar(s.wusd) : ""}</span>
    </div>`;
  };
  const rows = sortServers(gsHit.filter((s) => zoneOf(s) === "main")).map(row).join("");
  const zoneCards = ["end", "death"].map((z) => {
    const zl = sortServers(gsHit.filter((s) => zoneOf(s) === z));
    return zl.length ? `<div class="card glass"><h3>${ZONE_KO[z]}<span class="right">${zl.filter((s) => s.state === "on").length}/${zl.length}대 · ${num(zl.reduce((a, s) => a + (s.ccu || 0), 0))}명</span></h3>${zl.map(row).join("")}</div>` : "";
  }).join("");
  return `<div class="tools">
      <input id="q" type="search" placeholder="번호 · 이름 · 장비" value="${esc(state.q)}">
      <select id="sort">
        ${[["state", "상태순"], ["ccu", "접속자순"], ["fps", "FPS 낮은순"], ["num", "번호순"]].map(([v, l]) => `<option value="${v}"${state.sort === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="card glass">${rows || `<div class="empty">해당 게임서버 없음</div>`}</div>
    ${zoneCards}
    ${otherRows ? `<div class="card glass"><h3>기타 서버<span class="right">${others.filter((s) => serverLevel(s) === "ok").length}/${others.length} 켜짐</span></h3><ul class="list others">${otherRows}</ul></div>` : ""}`;
}

const gb = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${num(v, 1)}GB`);

function renderMachines() {
  const now = state.now;
  if (!now) return `<div class="empty">데이터를 불러오는 중입니다</div>`;
  const mt = (state.mtrend && state.mtrend.machines) || {};
  const cards = (now.machines || []).slice().sort((a, b) => (b.flags || []).length - (a.flags || []).length || String(a.name).localeCompare(String(b.name))).map((m) => {
    const used = m.mem_total_gb != null && m.mem_free_gb != null ? m.mem_total_gb - m.mem_free_gb : null;
    const pct = used != null && m.mem_total_gb ? (used / m.mem_total_gb) * 100 : null;
    const cls = (v) => (v == null ? "" : v >= 90 ? "bad" : v >= 75 ? "warn" : "");
    const drives = String(m.drives || "").split(":").filter(Boolean).map((d, i) => {
      const tot = (m.drive_total_gb || [])[i], free = (m.drive_free_gb || [])[i];
      return `${esc(d)}: ${num(free)} / ${num(tot)}GB`;
    }).join(" · ");
    const tr = mt[m.name];
    const flags = (m.flags || []).map((f) => `<span class="tag t-warn">${esc(MACHINE_FLAGS[f] || f)}</span>`).join(" ");
    return `<div class="card glass">
      <h3><span class="dot ${m.state === "off" ? "bad" : (m.flags || []).length ? "warn" : "ok"}" style="display:inline-block"></span> ${esc(m.name)} ${flags}</h3>
      <div class="grid3">
        <div class="kv"><div class="k">CPU</div><div class="v">${num(m.cpu, 0)}%</div><div class="bar"><span class="${cls(m.cpu)}" style="width:${m.cpu || 0}%"></span></div></div>
        <div class="kv"><div class="k">메모리</div><div class="v">${num(pct, 0)}%</div><div class="bar"><span class="${cls(pct)}" style="width:${pct || 0}%"></span></div></div>
        <div class="kv"><div class="k">네트워크</div><div class="v">${num(m.net, 1)}%</div></div>
      </div>
      <div class="sub">메모리 ${num(used, 1)} / ${num(m.mem_total_gb, 0)}GB · 게임서버 ${(m.servers || []).length}개 · 에이전트 ${esc(m.version || "-")}</div>
      ${drives ? `<div class="sub">디스크 여유 ${drives}</div>` : ""}
      ${tr ? chart([{ vals: tr.mem || [], cls: "s1", name: "메모리" }], { h: 60, zero: false, digits: 1, unit: "GB", time: (i) => hhmm(state.mtrend.start + i * state.mtrend.bucket) }) +
        `<div class="sub">24시간 메모리 · 1시간 ${gb(tr.d1h)} · 24시간 ${gb(tr.d24h)}${tr.slope6h != null ? ` · 기울기 ${num(tr.slope6h, 2)}GB/h` : ""}${tr.restart ? ` · 재시작 ${hhmm(tr.restart)}` : ""}</div>` : ""}
    </div>`;
  }).join("");
  return cards || `<div class="empty">장비 정보 없음</div>`;
}

function renderEvents() {
  const evs = ((state.events && state.events.events) || []).slice().reverse()
    .filter((e) => state.evf === "all" || e.sev === state.evf);
  const chips = [["all", "전체"], ["err", "오류"], ["warn", "경고"]].map(([v, l]) => `<button data-evf="${v}" class="${state.evf === v ? "on" : ""}">${l}</button>`).join("");
  const rows = evs.slice(0, 150).map((e) => `<div class="ev">
      <div class="h"><span class="tag t-${e.sev === "err" ? "bad" : e.sev === "warn" ? "warn" : e.sev === "ok" ? "ok" : "maint"}">${SEV_KO[e.sev] || esc(e.sev)}</span>
      <span class="muted">${mdhm(e.ep)}</span><b>${esc(e.server)}</b></div>
      <div class="msg">${esc(e.msg)}</div></div>`).join("");
  return `<div class="chips">${chips}</div><div class="card glass">${rows || `<div class="empty">이벤트 없음</div>`}</div>`;
}

function renderDetail() {
  const svid = state.detail;
  const s = ((state.now && state.now.servers) || []).find((x) => String(x.svid) === String(svid));
  const sheet = $("sheet");
  if (!s) { sheet.hidden = true; state.detail = null; return; }
  const today = state.trend && state.trend.today;
  const yest = state.trend && state.trend.yesterday;
  const lv = serverLevel(s);
  const w = s.wusd;
  const hist = state.hist && state.hist.servers && state.hist.servers[svid];
  let histHtml = `<div class="sub">${state.hist ? "30일 기록 없음" : "불러오는 중"}</div>`;
  if (hist) {
    const n = state.hist.slots;
    const full = (f) => { const a = new Array(n).fill(null); (hist[f] || []).forEach((v, i) => { a[hist.o + i] = v; }); return a; };
    const ticks = [];
    for (let i = 0; i < n; i += 24 * 7) ticks.push({ i, label: mdhm(state.hist.start + i * 3600).split(" ")[0] });
    const htime = (i) => `${mdhm(state.hist.start + i * 3600).split(" ")[0]} ${pad(new Date((state.hist.start + i * 3600) * 1000).getHours())}시`;
    histHtml = chart([{ vals: full("users"), cls: "s1", name: "최고 접속자" }], { ticks, time: htime, unit: "명" }) + legend([["c1", "시간별 최고 접속자"]]) +
      chart([{ vals: full("fps_min"), cls: "s3", name: "최저" }, { vals: full("fps_avg"), cls: "s1", name: "평균" }], { ticks, zero: false, time: htime, digits: 1 }) +
      legend([["c1", "FPS 평균"], ["c3", "FPS 최저"]]);
  }
  sheet.innerHTML = `
    <header class="top"><button id="back" class="round glass" aria-label="뒤로"><svg class="ic" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <span class="dot ${lv}"></span><h1>${esc(s.name)}</h1></header>
    <main>
      <div class="card glass grid">
        <div class="kv"><div class="k">접속자 · 오늘 최고</div><div class="v">${num(s.ccu)} · ${num(s.peak)}</div></div>
        <div class="kv"><div class="k">FPS</div><div class="v">${num(s.fps, 1)}</div></div>
        <div class="kv"><div class="k">CPU (한 코어 기준)</div><div class="v">${s.cpu == null ? "-" : num(s.cpu, 0) + "%"}</div></div>
        <div class="kv"><div class="k">메모리</div><div class="v">${s.mem_mb == null ? "-" : num(s.mem_mb / 1024, 1) + "GB"}</div></div>
        <div class="kv"><div class="k">처리 대기</div><div class="v">${num(s.wait)}</div></div>
        <div class="kv"><div class="k">연결</div><div class="v">${num(s.conn)}</div></div>
        <div class="kv"><div class="k">상태</div><div class="v" style="font-size:14px">${esc(s.cond || "-")} · ${esc(serverIssues(s).join(", ") || LEVEL_KO[lv])}</div></div>
        <div class="kv"><div class="k">장비 · 종류</div><div class="v" style="font-size:14px">${esc(s.agent)} · ${esc(s.type)}</div></div>
        <div class="kv"><div class="k">빌드</div><div class="v" style="font-size:14px">${esc(s.build || "-")}</div></div>
        <div class="kv"><div class="k">시작</div><div class="v" style="font-size:14px">${esc(s.start || "-")}</div></div>
      </div>
      ${w ? `<div class="card glass"><h3>틱 구성 (틱당 ${num(w.ms, 2)}ms)</h3>${wusdBar(w)}
        <div class="legend"><span><i class="w-w"></i>W ${num(w.w, 1)}%</span><span><i class="w-u"></i>U ${num(w.u, 1)}%</span><span><i class="w-s"></i>S ${num(w.s, 1)}%</span><span><i class="w-d"></i>D ${num(w.d, 1)}%</span></div></div>` : ""}
      <div class="card glass"><h3>오늘 (5분)</h3>
        ${chart([{ vals: serverSeries(yest, svid, "users"), cls: "s2", name: "어제" }, { vals: serverSeries(today, svid, "users"), cls: "s1", name: "오늘" }], { ticks: dayTicks(today), time: slotTime(today && today.bucket), unit: "명" })}
        ${legend([["c1", "접속자 오늘"], ["c2", "어제"]])}
        ${chart([{ vals: serverSeries(today, svid, "fps_min"), cls: "s3", name: "최저" }, { vals: serverSeries(today, svid, "fps_avg"), cls: "s1", name: "평균" }], { ticks: dayTicks(today), zero: false, time: slotTime(today && today.bucket), digits: 1 })}
        ${legend([["c1", "FPS 평균"], ["c3", "FPS 최저"]])}
        ${chart([{ vals: serverSeries(today, svid, "cpu"), cls: "s1", name: "CPU" }], { ticks: dayTicks(today), max: 100, time: slotTime(today && today.bucket), unit: "%" })}
        ${legend([["c1", "CPU %"]])}
        ${chart([{ vals: serverSeries(today, svid, "dba_wait_ms"), cls: "s3", name: "DB 대기" }], { ticks: dayTicks(today), time: slotTime(today && today.bucket), unit: "ms" })}
        ${legend([["c3", "DB 대기 ms (최고)"]])}
      </div>
      <div class="card glass"><h3>최근 30일 (1시간)</h3>${histHtml}</div>
      <div class="card glass"><h3>최근 이벤트</h3>${((state.events && state.events.events) || []).filter((e) => String(e.svid) === String(svid)).slice(-20).reverse()
        .map((e) => `<div class="ev"><div class="h"><span class="muted">${mdhm(e.ep)}</span><span>${SEV_KO[e.sev] || esc(e.sev)}</span></div><div class="msg">${esc(e.msg)}</div></div>`).join("") || `<div class="sub">없음</div>`}</div>
    </main>`;
  sheet.hidden = false;
  $("back").onclick = closeDetail;
  applyPin();
}

function openDetail(svid) {
  state.detail = String(svid);
  history.pushState({ detail: state.detail }, "");
  renderDetail();
  if (Date.now() - state.at.hist > 600000) fetchFile("hist", "hist.json").then(() => state.detail && renderDetail());
}

function closeDetail() {
  if (history.state && history.state.detail) history.back();
  else { state.detail = null; $("sheet").hidden = true; }
}

const TITLES = { sum: "", srv: "서버", mach: "장비", ev: "이벤트" };

function render() {
  if (state.scrub) { state.pendingRender = true; return; }
  CHARTS.clear();
  const now = state.now;
  const sky = skyOf(now && now.level);
  if (document.documentElement.dataset.sky !== sky) {
    document.documentElement.dataset.sky = sky;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = SKY_TOP[sky] || "#2a72cf";
  }
  $("title").textContent = TITLES[state.tab];
  updateAge();
  const view = $("view");
  const html = { sum: renderSummary, srv: renderServers, mach: renderMachines, ev: renderEvents }[state.tab]();
  const focus = document.activeElement && document.activeElement.id === "q";
  const caret = focus ? document.activeElement.selectionStart : null;
  const hoursX = $("hours") ? $("hours").scrollLeft : null;
  view.innerHTML = html;
  if (focus && $("q")) { $("q").focus(); try { $("q").setSelectionRange(caret, caret); } catch (e) { } }
  const hs = $("hours");
  if (hs) hs.scrollLeft = hoursX == null || hoursX >= hs.scrollWidth - hs.clientWidth - 60 ? hs.scrollWidth : hoursX;
  if (state.detail) renderDetail();
  applyPin();
}

function updateAge() {
  const now = state.now;
  const banner = $("banner");
  let msg = state.err || "";
  if (now && now.mirror) {
    const ageMirror = Date.now() / 1000 - now.mirror.ts;
    const ageLive = now.mirror.ts - (now.ts || 0);
    $("age").textContent = `${Math.max(0, Math.round(ageMirror))}초 전`;
    if (!msg && ageMirror > Math.max(180, (now.mirror.interval || 30) * 4)) msg = `송출이 ${Math.round(ageMirror / 60)}분째 멈춰 있습니다 (마지막 ${mdhm(now.mirror.ts)}).`;
    else if (!msg && ageLive > 90) msg = `수집기 데이터가 ${Math.round(ageLive / 60)}분 전 것입니다.`;
    else if (!msg && now.collector && now.collector.quiet) msg = "수집기 조용한 시간대(09:00-09:45)라 갱신이 느릴 수 있습니다.";
  }
  banner.hidden = !msg;
  banner.textContent = msg;
}

async function fetchFile(key, file) {
  const doc = await load(file);
  state[key] = doc;
  state.at[key] = Date.now();
  return doc;
}

async function tick(force) {
  if (state.busy || !recall(TOKEN_KEY)) return;
  if (document.hidden && !force) return;
  state.busy = true;
  const t = Date.now();
  try {
    const jobs = [fetchFile("now", "now.json").then((d) => store(CACHE_KEY, JSON.stringify(d)))];
    if (force || t - state.at.trend > 60000) jobs.push(load("trend.json").then((d) => {
      state.at.trend = Date.now();
      if (d && d.today) { state.trend = d; store(TREND_CACHE_KEY, JSON.stringify(d)); }
    }));
    if (force || t - state.at.events > 30000) jobs.push(fetchFile("events", "events.json"));
    if ((state.tab === "mach" && (force || t - state.at.mtrend > 120000)) || t - state.at.mtrend > 600000) jobs.push(fetchFile("mtrend", "mtrend.json"));
    if (state.detail && t - state.at.hist > 600000) jobs.push(fetchFile("hist", "hist.json"));
    await Promise.all(jobs);
    state.err = null;
    accSync(false);
  } catch (e) {
    if (e instanceof AuthError) { showLogin(e.message); state.busy = false; return; }
    state.err = `갱신 실패: ${e.message}`;
  }
  state.busy = false;
  render();
}

function showLogin(msg) {
  $("login").hidden = false;
  $("who").value = recall(NAME_KEY);
  $("tokMsg").textContent = msg || "";
}

function bind() {
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    render();
    window.scrollTo(0, 0);
    if (state.tab === "mach" && Date.now() - state.at.mtrend > 120000) fetchFile("mtrend", "mtrend.json").then(render).catch(() => { });
  });
  $("view").addEventListener("click", (e) => {
    const row = e.target.closest("[data-svid]");
    if (row) return openDetail(row.dataset.svid);
    if (e.target.closest('[data-act="forget"]')) {
      if (confirm("이 기기에 저장된 토큰을 지울까요? 다시 보려면 토큰을 새로 입력해야 합니다.")) {
        accSync(true, true); accReset(); acc.fp = null;
        store(TOKEN_KEY, null); store(CACHE_KEY, null); store(TREND_CACHE_KEY, null); showLogin("");
      }
      return;
    }
    const chip = e.target.closest("[data-evf]");
    if (chip) { state.evf = chip.dataset.evf; render(); }
  });
  $("view").addEventListener("input", (e) => { if (e.target.id === "q") { state.q = e.target.value; render(); } });
  $("view").addEventListener("change", (e) => { if (e.target.id === "sort") { state.sort = e.target.value; render(); } });
  $("refresh").onclick = () => tick(true);

  $("tokSave").onclick = async () => {
    const name = $("who").value.trim();
    const v = $("tok").value.trim() || recall(TOKEN_KEY);
    if (!name) { $("tokMsg").textContent = "이름을 적어 주세요."; return; }
    if (!v) { $("tokMsg").textContent = "토큰을 적어 주세요."; return; }
    if (v !== recall(TOKEN_KEY)) { accReset(); acc.fp = null; }
    store(NAME_KEY, name);
    store(TOKEN_KEY, v);
    $("tokMsg").textContent = "확인 중...";
    try {
      await fetchFile("now", "now.json");
      $("login").hidden = true;
      $("tok").value = "";
      tick(true);
    } catch (e) {
      $("tokMsg").textContent = e.message;
      if (e instanceof AuthError) store(TOKEN_KEY, null);
    }
  };
  document.addEventListener("pointerdown", (e) => {
    const wrap = e.target.closest(".chartwrap");
    state.down = { x: e.clientX, y: e.clientY, onChart: !!wrap };
    if (!wrap) return;
    state.scrub = wrap;
    scrubAt(wrap, e.clientX);
  });
  document.addEventListener("pointermove", (e) => { if (state.scrub) scrubAt(state.scrub, e.clientX); });
  document.addEventListener("pointerup", scrubEnd);
  document.addEventListener("pointercancel", scrubEnd);
  window.addEventListener("popstate", () => { if (state.detail) { state.detail = null; $("sheet").hidden = true; } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(true); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) tick(true); });
}

function diag() {
  let box = $("diag");
  if (!box) {
    box = document.createElement("pre");
    box.id = "diag";
    box.style.cssText = "position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:99;margin:0;padding:8px 10px;border-radius:10px;" +
      "background:rgba(0,0,0,.8);color:#fff;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none";
    document.body.appendChild(box);
  }
  const de = document.documentElement, vv = window.visualViewport, W = de.clientWidth;
  const cls = (e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || "").split(" ")[0];
  const wide = [...document.querySelectorAll("body *")]
    .filter((e) => e.id !== "diag" && !e.closest("#diag") && !(e.closest(".hours") && !e.classList.contains("hours")))
    .map((e) => [e, e.getBoundingClientRect()])
    .filter(([, r]) => r.width > 0 && r.height > 0 && (r.right > W + 0.5 || r.left < -0.5))
    .sort((a, b) => b[1].right - a[1].right).slice(0, 8)
    .map(([e, r]) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${cls(e)} ${Math.round(r.left)}..${Math.round(r.right)} w${Math.round(r.width)}`);
  box.textContent = [
    `screen ${screen.width} inner ${innerWidth} client ${W} scroll ${de.scrollWidth} body ${document.body.scrollWidth}`,
    `vv ${vv ? `${Math.round(vv.width)} scale ${vv.scale.toFixed(3)} left ${Math.round(vv.offsetLeft)}` : "-"} dpr ${devicePixelRatio} scrollX ${Math.round(scrollX)}`,
    `${navigator.userAgent.replace(/^.*?\(([^)]*)\).*$/, "$1")}`,
    ...(wide.length ? wide : ["no element outside client width"]),
  ].join("\n");
}

function start() {
  bind();
  if (/[?&]diag\b/.test(location.search)) { setInterval(diag, 1000); window.addEventListener("scroll", diag, { passive: true }); }
  if ((CFG.demo || /[?&]demo\b/.test(location.search)) && window.parent !== window) {
    document.documentElement.classList.add("demo");
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || d.type !== "potc-demo") return;
      Object.assign(state, { now: d.now || state.now, trend: d.trend || state.trend, events: d.events || state.events, mtrend: d.mtrend || state.mtrend, err: null });
      render();
    });
    window.parent.postMessage({ type: "potc-demo-ready" }, "*");
    render();
    return;
  }
  if (!CFG.owner || !CFG.repo) { showLogin("뷰어 설정(config.js)이 없습니다."); return; }
  try { const c = recall(CACHE_KEY); if (c) state.now = JSON.parse(c); } catch (e) { }
  try {
    const c = recall(TREND_CACHE_KEY);
    const d = c ? JSON.parse(c) : null;
    const midnight = new Date().setHours(0, 0, 0, 0) / 1000;
    if (d && d.today && Math.abs(d.today.day_start - midnight) < 120) state.trend = d;
  } catch (e) { }
  render();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { accCount(); accSync(true, true); return; }
    if (acc.id && Date.now() / 1000 - acc.last > ACC_GAP) accReset();
    acc.seenAt = Date.now() / 1000;
  });
  if (!recall(TOKEN_KEY)) { showLogin(""); return; }
  if (!recall(NAME_KEY)) showLogin("이름을 적어 주세요. 토큰은 저장돼 있어 비워 둬도 됩니다.");
  tick(true);
  setInterval(() => tick(false), POLL_MS);
  setInterval(updateAge, 1000);
}

start();
