"use strict";

const CFG = window.MON_CFG || {};
const API = (CFG.api || "https://api.github.com").replace(/\/$/, "");
const TOKEN_KEY = "potc.live.token";
const CACHE_KEY = "potc.live.now";
const POLL_MS = Math.max(5, CFG.poll || 15) * 1000;
const MAINT = new Set(["----", "BLOCKED", "NotConnect", "Maintenance"]);
const BAD_FLAGS = { server_down: "서버 끊김", agent_down: "에이전트 끊김", frame_stop: "프레임 정지" };
const WARN_FLAGS = { high_dispatch: "처리 대기 적체" };
const MACHINE_FLAGS = { cpu: "CPU 95%+", net: "네트워크 95%+", mem: "메모리 부족", drive: "디스크 부족", stale: "정보 끊김" };
const LEVEL_KO = { ok: "정상", warn: "주의", bad: "이상", maint: "점검" };
const SEV_KO = { err: "오류", warn: "경고", ok: "복구", info: "정보" };

const state = {
  now: null, trend: null, mtrend: null, events: null, hist: null,
  at: { now: 0, trend: 0, mtrend: 0, events: 0, hist: 0 },
  tab: "sum", sort: "state", q: "", evf: "all", detail: null, err: null, rlUntil: 0, busy: false,
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

async function load(file) {
  if (Date.now() < state.rlUntil) throw new Error(`요청 한도 초과, ${hhmm(state.rlUntil / 1000)} 이후 재개`);
  const url = `${API}/repos/${CFG.owner}/${CFG.repo}/contents/${file}?ref=${encodeURIComponent(CFG.branch || "live")}`;
  const r = await fetch(url, {
    cache: "no-cache",
    headers: { Authorization: `Bearer ${recall(TOKEN_KEY)}`, Accept: "application/vnd.github.raw+json" },
  });
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    <line class="axis" x1="${L}" y1="${y(min)}" x2="${W}" y2="${y(min)}"/>
    <line class="axis" x1="${L}" y1="${y(max)}" x2="${W}" y2="${y(max)}"/>
    <text x="${L - 4}" y="${y(max) + 3}" text-anchor="end">${fmt(max)}</text>
    <text x="${L - 4}" y="${y(min) + 3}" text-anchor="end">${fmt(min)}</text>
    ${paths}${ticks}</svg>`;
}

function dayTicks(trend) {
  const per = 3600 / ((trend && trend.bucket) || 300);
  return [0, 6, 12, 18, 24].map((h) => ({ i: Math.min(h * per, (trend ? trend.slots : 288) - 1), label: `${h}시` }));
}

function legend(items) {
  return `<div class="legend">${items.map(([cls, label]) => `<span><i style="background:var(--${cls})"></i>${esc(label)}</span>`).join("")}</div>`;
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
      cmp = `<span class="${diff >= 0 ? "up" : "down"}">어제 이 시각 ${num(yv)} (${diff >= 0 ? "+" : ""}${num(diff)})</span>`;
    }
  }
  const mobile = t.mobile || 0;
  const other = t.users != null ? Math.max(0, t.users - mobile) : null;
  const dauKeys = Object.keys(now.dau || {}).sort();
  const dauT = dauKeys.length ? now.dau[dauKeys[dauKeys.length - 1]] : null;
  const dauY = dauKeys.length > 1 ? now.dau[dauKeys[dauKeys.length - 2]] : null;
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
  return `
    <div class="card">
      <h3>총 접속자 <span class="tag t-${now.level}">${LEVEL_KO[now.level] || now.level || "-"}</span></h3>
      <div class="big">${num(t.users)}</div>
      <div class="sub">오늘 최고 ${num(t.peak)}${cmp ? ` · ${cmp}` : ""}</div>
      ${tSeries ? chart([{ vals: ySeries || [], cls: "s2" }, { vals: tSeries, cls: "s1" }], { ticks: dayTicks(today) }) + legend([["c1", "오늘"], ["c2", "어제"]]) : ""}
    </div>
    <div class="card"><h3>경보 ${issues.length ? `(${issues.length})` : ""}</h3>
      ${issues.length ? `<ul class="list">${issues.map((x) => `<li${x.svid != null ? ` data-svid="${x.svid}"` : ""}><span class="tag t-${x.lv}">${x.lv === "bad" ? "이상" : "주의"}</span><span>${esc(x.text)}</span></li>`).join("")}</ul>` : `<div class="sub">현재 경보 없음</div>`}
    </div>
    ${incidents ? `<div class="card"><h3>경보 분석 (최근 6시간)</h3><ul class="list">${incidents}</ul></div>` : ""}
    <div class="card grid">
      <div class="kv"><div class="k">서버</div><div class="v">${num(t.servers_on)} / ${num(t.servers)}</div></div>
      <div class="kv"><div class="k">FPS 평균 · 최저</div><div class="v">${num(t.fps_avg, 1)} · ${num(t.fps_min, 1)}</div></div>
      <div class="kv"><div class="k">모바일 (AOS · iOS)</div><div class="v">${num(mobile)} <span class="sub">(${num(t.aos)} · ${num(t.ios)})</span></div></div>
      <div class="kv"><div class="k">그 외</div><div class="v">${num(other)}</div></div>
      <div class="kv"><div class="k">DAU (마스터 기준일)</div><div class="v">${num(dauT)}</div></div>
      <div class="kv"><div class="k">전일 DAU</div><div class="v">${num(dauY)}</div></div>
      <div class="kv"><div class="k">장비</div><div class="v">${num(t.machines)} <span class="sub">주의 ${num(t.machines_warn)}</span></div></div>
      <div class="kv"><div class="k">마스터</div><div class="v" style="font-size:14px">${esc((now.master || {}).version || "-")}</div></div>
    </div>`;
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
  const list = sortServers((now.servers || []).filter((s) => !q || `${s.svid} ${s.name} ${s.agent} ${s.type}`.toLowerCase().includes(q)));
  const rows = list.map((s) => {
    const lv = serverLevel(s);
    const iss = serverIssues(s);
    return `<div class="srv" data-svid="${s.svid}">
      <span class="dot ${lv}"></span>
      <span class="name">${esc(s.name)}</span>
      <span class="nums">${num(s.ccu)}명 · ${num(s.fps, 0)}fps · ${s.cpu == null ? "-" : num(s.cpu, 0) + "%"}</span>
      <span class="meta">${esc(s.type)} · ${esc(s.agent)} · ${esc(s.cond || "-")}${iss.length ? ` · <b class="t-${lv}">${esc(iss.join(", "))}</b>` : ""}${s.type === "GS" ? wusdBar(s.wusd) : ""}</span>
    </div>`;
  }).join("");
  return `<div class="tools">
      <input id="q" type="search" placeholder="번호 · 이름 · 장비" value="${esc(state.q)}">
      <select id="sort">
        ${[["state", "상태순"], ["ccu", "접속자순"], ["fps", "FPS 낮은순"], ["num", "번호순"]].map(([v, l]) => `<option value="${v}"${state.sort === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="card">${rows || `<div class="empty">해당 서버 없음</div>`}</div>`;
}

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
    return `<div class="card">
      <h3><span class="dot ${m.state === "off" ? "bad" : (m.flags || []).length ? "warn" : "ok"}" style="display:inline-block"></span> ${esc(m.name)} ${flags}</h3>
      <div class="grid3">
        <div class="kv"><div class="k">CPU</div><div class="v">${num(m.cpu, 0)}%</div><div class="bar"><span class="${cls(m.cpu)}" style="width:${m.cpu || 0}%"></span></div></div>
        <div class="kv"><div class="k">메모리</div><div class="v">${num(pct, 0)}%</div><div class="bar"><span class="${cls(pct)}" style="width:${pct || 0}%"></span></div></div>
        <div class="kv"><div class="k">네트워크</div><div class="v">${num(m.net, 1)}%</div></div>
      </div>
      <div class="sub">메모리 ${num(used, 1)} / ${num(m.mem_total_gb, 0)}GB · 게임서버 ${(m.servers || []).length}개 · 에이전트 ${esc(m.version || "-")}</div>
      ${drives ? `<div class="sub">디스크 여유 ${drives}</div>` : ""}
      ${tr ? chart([{ vals: tr.mem || [], cls: "s1" }], { h: 60, zero: false }) +
        `<div class="sub">24시간 메모리 · 1시간 ${tr.d1h == null ? "-" : (tr.d1h >= 0 ? "+" : "") + num(tr.d1h, 1)}GB · 24시간 ${tr.d24h == null ? "-" : (tr.d24h >= 0 ? "+" : "") + num(tr.d24h, 1)}GB${tr.slope6h != null ? ` · 기울기 ${num(tr.slope6h, 2)}GB/h` : ""}${tr.restart ? ` · 재시작 ${hhmm(tr.restart)}` : ""}</div>` : ""}
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
  return `<div class="chips">${chips}</div><div class="card">${rows || `<div class="empty">이벤트 없음</div>`}</div>`;
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
    histHtml = chart([{ vals: full("users"), cls: "s1" }], { ticks }) + legend([["c1", "시간별 최고 접속자"]]) +
      chart([{ vals: full("fps_min"), cls: "s3" }, { vals: full("fps_avg"), cls: "s1" }], { ticks, zero: false }) +
      legend([["c1", "FPS 평균"], ["c3", "FPS 최저"]]);
  }
  sheet.innerHTML = `
    <header class="top"><button id="back" class="icon" aria-label="뒤로">&#8592;</button>
      <span class="dot ${lv}"></span><h1>${esc(s.name)}</h1></header>
    <main>
      <div class="card grid">
        <div class="kv"><div class="k">접속자 · 오늘 최고</div><div class="v">${num(s.ccu)} · ${num(s.peak)}</div></div>
        <div class="kv"><div class="k">FPS</div><div class="v">${num(s.fps, 1)}</div></div>
        <div class="kv"><div class="k">CPU (한 코어 기준)</div><div class="v">${s.cpu == null ? "-" : num(s.cpu, 0) + "%"}</div></div>
        <div class="kv"><div class="k">메모리</div><div class="v">${s.mem_mb == null ? "-" : num(s.mem_mb / 1024, 1) + "GB"}</div></div>
        <div class="kv"><div class="k">처리 대기</div><div class="v">${num(s.wait)}</div></div>
        <div class="kv"><div class="k">모바일 (AOS · iOS)</div><div class="v">${num(s.mobile)} <span class="sub">(${num(s.aos)} · ${num(s.ios)})</span></div></div>
        <div class="kv"><div class="k">상태</div><div class="v" style="font-size:14px">${esc(s.cond || "-")} · ${esc(serverIssues(s).join(", ") || LEVEL_KO[lv])}</div></div>
        <div class="kv"><div class="k">장비 · 종류</div><div class="v" style="font-size:14px">${esc(s.agent)} · ${esc(s.type)}</div></div>
      </div>
      ${w ? `<div class="card"><h3>틱 구성 (틱당 ${num(w.ms, 2)}ms)</h3>${wusdBar(w)}
        <div class="legend"><span><i class="w-w"></i>W ${num(w.w, 1)}%</span><span><i class="w-u"></i>U ${num(w.u, 1)}%</span><span><i class="w-s"></i>S ${num(w.s, 1)}%</span><span><i class="w-d"></i>D ${num(w.d, 1)}%</span></div></div>` : ""}
      <div class="card"><h3>오늘 (5분)</h3>
        ${chart([{ vals: serverSeries(yest, svid, "users"), cls: "s2" }, { vals: serverSeries(today, svid, "users"), cls: "s1" }], { ticks: dayTicks(today) })}
        ${legend([["c1", "접속자 오늘"], ["c2", "어제"]])}
        ${chart([{ vals: serverSeries(today, svid, "fps_min"), cls: "s3" }, { vals: serverSeries(today, svid, "fps_avg"), cls: "s1" }], { ticks: dayTicks(today), zero: false })}
        ${legend([["c1", "FPS 평균"], ["c3", "FPS 최저"]])}
        ${chart([{ vals: serverSeries(today, svid, "cpu"), cls: "s1" }], { ticks: dayTicks(today), max: 100 })}
        ${legend([["c1", "CPU %"]])}
        ${chart([{ vals: serverSeries(today, svid, "dba_wait_ms"), cls: "s3" }], { ticks: dayTicks(today) })}
        ${legend([["c3", "DB 대기 ms (최고)"]])}
      </div>
      <div class="card"><h3>최근 30일 (1시간)</h3>${histHtml}</div>
      <div class="card"><h3>최근 이벤트</h3>${((state.events && state.events.events) || []).filter((e) => String(e.svid) === String(svid)).slice(-20).reverse()
        .map((e) => `<div class="ev"><div class="h"><span class="muted">${mdhm(e.ep)}</span><span>${SEV_KO[e.sev] || esc(e.sev)}</span></div><div class="msg">${esc(e.msg)}</div></div>`).join("") || `<div class="sub">없음</div>`}</div>
    </main>`;
  sheet.hidden = false;
  $("back").onclick = closeDetail;
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

function render() {
  const now = state.now;
  $("lvl").className = `dot ${now ? now.level : ""}`;
  updateAge();
  const view = $("view");
  const html = { sum: renderSummary, srv: renderServers, mach: renderMachines, ev: renderEvents }[state.tab]();
  const focus = document.activeElement && document.activeElement.id === "q";
  const caret = focus ? document.activeElement.selectionStart : null;
  view.innerHTML = html;
  if (focus && $("q")) { $("q").focus(); try { $("q").setSelectionRange(caret, caret); } catch (e) { } }
  if (state.detail) renderDetail();
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
    if (force || t - state.at.trend > 60000) jobs.push(fetchFile("trend", "trend.json"));
    if (force || t - state.at.events > 30000) jobs.push(fetchFile("events", "events.json"));
    if ((state.tab === "mach" && (force || t - state.at.mtrend > 120000)) || t - state.at.mtrend > 600000) jobs.push(fetchFile("mtrend", "mtrend.json"));
    if (state.detail && t - state.at.hist > 600000) jobs.push(fetchFile("hist", "hist.json"));
    await Promise.all(jobs);
    state.err = null;
  } catch (e) {
    if (e instanceof AuthError) { showLogin(e.message); state.busy = false; return; }
    state.err = `갱신 실패: ${e.message}`;
  }
  state.busy = false;
  render();
}

function showLogin(msg) {
  $("login").hidden = false;
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
    const chip = e.target.closest("[data-evf]");
    if (chip) { state.evf = chip.dataset.evf; render(); }
  });
  $("view").addEventListener("input", (e) => { if (e.target.id === "q") { state.q = e.target.value; render(); } });
  $("view").addEventListener("change", (e) => { if (e.target.id === "sort") { state.sort = e.target.value; render(); } });
  $("refresh").onclick = () => tick(true);
  $("gear").onclick = () => {
    if (confirm("이 기기에 저장된 토큰을 지울까요?")) { store(TOKEN_KEY, null); store(CACHE_KEY, null); showLogin(""); }
  };
  $("tokSave").onclick = async () => {
    const v = $("tok").value.trim();
    if (!v) return;
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
  window.addEventListener("popstate", () => { if (state.detail) { state.detail = null; $("sheet").hidden = true; } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(true); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) tick(true); });
}

function start() {
  bind();
  if (!CFG.owner || !CFG.repo) { showLogin("뷰어 설정(config.js)이 없습니다."); return; }
  try { const c = recall(CACHE_KEY); if (c) state.now = JSON.parse(c); } catch (e) { }
  render();
  if (!recall(TOKEN_KEY)) { showLogin(""); return; }
  tick(true);
  setInterval(() => tick(false), POLL_MS);
  setInterval(updateAge, 1000);
}

start();
