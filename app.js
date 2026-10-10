"use strict";

/* ================= 유틸 ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");

/** DOM 생성 헬퍼. 문자열 자식은 textContent로만 들어가므로 기사 내용이 HTML로 해석되지 않는다. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

async function api(path, opts = {}) {
  if (STATIC) return staticApi(path, opts);
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch("/api/" + path, init);
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

/* ================= 정적 사이트 모드 (GitHub Pages) =================
   서버 없이 Mac 앱이 게시한 JSON을 읽는다. 스크랩·메모·읽음 등은 이 기기 브라우저에만 저장. */
const STATIC = !!window.AX_STATIC;
const READONLY = "공개 사이트에서는 바꿀 수 없습니다 — 소스·설정 변경과 수집은 Mac 앱에서 해주세요";
const LOCAL_KEY = "ax-local-v1";
const localStore = {
  load() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { return {}; } },
  save(m) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(m)); } catch { toast("이 브라우저에는 저장할 수 없습니다", true); } },
};
const EMPTY_STATE = { is_read: 0, is_pinned: 0, feedback: 0, note: "", is_hidden: 0 };
let jsonCache = {};
function getJSON(p) {
  if (!jsonCache[p]) jsonCache[p] = fetch(p, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(r.status === 404 ? "게시된 데이터가 없습니다" : r.statusText);
    return r.json();
  }).catch((e) => { delete jsonCache[p]; throw e; });
  return jsonCache[p];
}
const withLocal = (a, m = localStore.load()) => ({ ...a, ...EMPTY_STATE, ...(m[a.id]?.state || {}) });

async function staticApi(path, opts = {}) {
  const method = opts.method || "GET";
  const [p, qstr] = path.split("?");
  const qs = Object.fromEntries(new URLSearchParams(qstr || ""));
  const parts = p.split("/");
  if (method !== "GET" && parts[0] !== "articles") throw new Error(READONLY);
  const meta = await getJSON("data/meta.json");

  if (p === "stats") {
    const m = localStore.load(), cfg = await getJSON("data/config.json");
    const arts = await getJSON("data/articles.json"), dayAgo = Date.now() - 864e5;
    return {
      articles: meta.articles, sources: meta.sources,
      pinned: Object.values(m).filter((x) => x.state?.is_pinned).length,
      unread_today: arts.filter((a) => a.score >= cfg.settings.briefing_threshold && new Date(a.published_at) >= dayAgo
        && !m[a.id]?.state?.is_read && !m[a.id]?.state?.is_hidden).length,
      status: { running: false, done: 0, total: 0, last_run: meta.last_run, message: "",
                publish: `사이트 갱신 ${ago(meta.generated_at)}` },
    };
  }
  if (p === "config") return { keywords: {}, ...(await getJSON("data/config.json")) };
  if (p === "trends") return getJSON("data/trends.json");
  if (p === "sources") return getJSON("data/sources.json");

  if (p === "briefing") {
    const date = qs.date || meta.dates[0];
    if (!meta.dates.includes(date)) throw new Error("공개 사이트에는 최근 7일 브리핑만 있습니다");
    const b = structuredClone(await getJSON(`data/briefing/${date}_${qs.hours || "auto"}.json`));
    const m = localStore.load(), keep = (a) => !m[a.id]?.state?.is_hidden;
    b.top = b.top.filter(keep).map((a) => withLocal(a, m));
    b.sections = b.sections.map((s) => ({ ...s, items: s.items.filter(keep).map((a) => withLocal(a, m)) })).filter((s) => s.items.length);
    return b;
  }

  if (parts[0] === "articles") {
    const arts = await getJSON("data/articles.json");
    const id = +parts[1];
    if (method === "GET" && parts[2] === "cluster") {
      const a = arts.find((x) => x.id === id);
      return a ? arts.filter((x) => x.cluster_id === a.cluster_id).sort((x, y) => x.published_at.localeCompare(y.published_at)) : [];
    }
    if (method === "POST" && parts[1] === "read") {
      const m = localStore.load();
      for (const i of opts.body.ids || []) m[i] = { ...m[i], state: { ...(m[i]?.state || {}), is_read: 1 } };
      localStore.save(m);
      return { ok: true };
    }
    if (method === "PATCH" && id) {
      const m = localStore.load();
      const snap = arts.find((x) => x.id === id) || m[id]?.snap;
      if (!snap) throw new Error("기사를 찾을 수 없습니다");
      const state = { ...EMPTY_STATE, ...(m[id]?.state || {}) };
      for (const k of Object.keys(EMPTY_STATE)) if (k in opts.body) state[k] = k === "note" ? String(opts.body[k]) : +opts.body[k];
      m[id] = { state, snap: state.is_pinned || state.note ? snap : undefined };  // 스크랩은 사이트에서 빠져도 남도록 사본 보관
      localStore.save(m);
      return { ...snap, ...state };
    }
    if (method !== "GET") throw new Error(READONLY);
    const m = localStore.load();
    let list;
    if (qs.pinned === "1") {
      list = Object.values(m).filter((x) => x.state?.is_pinned && x.snap).map((x) => ({ ...x.snap, ...EMPTY_STATE, ...x.state }));
    } else {
      list = arts.map((a) => withLocal(a, m)).filter((a) => (qs.hidden === "1" ? a.is_hidden : !a.is_hidden));
    }
    const q = (qs.q || "").toLowerCase();
    if (q) list = list.filter((a) => `${a.title} ${a.summary} ${a.note}`.toLowerCase().includes(q));
    if (qs.category) list = list.filter((a) => a.category === qs.category);
    if (qs.source_id) list = list.filter((a) => String(a.source_id) === String(qs.source_id));
    if (qs.min_score) list = list.filter((a) => a.score >= +qs.min_score);
    if (qs.days && qs.pinned !== "1") { const since = Date.now() - qs.days * 864e5; list = list.filter((a) => new Date(a.published_at) >= since); }
    if (qs.unread === "1") list = list.filter((a) => !a.is_read);
    if (qs.group === "1") {
      const best = {};
      for (const a of list) if (!best[a.cluster_id] || a.score > best[a.cluster_id].score) best[a.cluster_id] = a;
      list = list.filter((a) => best[a.cluster_id] === a);
    }
    list.sort(qs.sort === "date" ? (x, y) => y.published_at.localeCompare(x.published_at)
                                 : (x, y) => y.score - x.score || y.published_at.localeCompare(x.published_at));
    const page = Math.max(1, +qs.page || 1), size = Math.min(200, +qs.size || 50);
    return { total: list.length, page, size, items: list.slice((page - 1) * size, page * size) };
  }
  throw new Error(READONLY);
}

function toast(msg, err = false) {
  const t = h("div", { class: "toast" + (err ? " err" : "") }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), err ? 5000 : 2600);
}

function ago(iso) {
  if (!iso) return "";
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
const todayStr = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD (로컬)

let CONFIG = null;
async function config() {
  if (!CONFIG) CONFIG = await api("config");
  return CONFIG;
}
const catIcon = (name) => (CONFIG?.categories.find((c) => c.name === name) || {}).icon || "";

/* ================= 기사 컴포넌트 ================= */
function scoreBadge(s) {
  const cls = s >= 5 ? "score hi" : s >= 3.5 ? "score mid" : "score";  // 점수 표시: 5 이상 강조
  return h("span", { class: cls, title: "관련도 점수 (0~10)" }, s.toFixed(1));
}

function keywordChips(matched) {
  const shown = Array.isArray(matched) ? matched.slice(0, 6) : [];
  return shown.length ? h("div", { class: "kws" }, shown.map((k) =>
    h("span", { class: "chip kw" + (k.startsWith("제외:") ? " ex" : "") }, k))) : null;
}

/**
 * 기사 한 건. a: 기사 객체(related 배열 또는 related_count 포함 가능).
 * variant: "top" | "row"
 */
function articleEl(a, { variant = "row", rank = null, onChange = null, showCat = true } = {}) {
  const root = h("article", { class: (variant === "top" ? "top-card" : "item") + (a.is_read ? " is-read" : "") });
  let noteOpen = false, relOpen = false;

  const patch = async (body, msg) => {
    try {
      const r = await api(`articles/${a.id}`, { method: "PATCH", body });
      Object.assign(a, r);
      if (msg) toast(msg);
      render();
      onChange?.(a, body);
      refreshStats();
    } catch (e) { toast(e.message, true); }
  };

  const markRead = () => { if (!a.is_read) { a.is_read = 1; root.classList.add("is-read"); api(`articles/${a.id}`, { method: "PATCH", body: { is_read: 1 } }).then(refreshStats); } };

  const relatedCount = Math.max(a.related ? a.related.length : 0, a.related_count || 0);

  async function toggleRelated() {
    relOpen = !relOpen;
    if (relOpen && (!a.related || a.related.length < relatedCount)) {
      const all = await api(`articles/${a.id}/cluster`);
      a.related = all.filter((x) => x.id !== a.id);
    }
    render();
  }

  function render() {
    root.replaceChildren();
    const title = h("div", { class: "title" },
      a.is_update ? h("span", { class: "chip upd", style: "margin-right:10px" }, "후속") : null,
      h("a", { href: safeUrl(a.url), target: "_blank", rel: "noopener noreferrer", onclick: markRead, onauxclick: markRead }, a.title));
    const left = h("div", { class: "left" },
      showCat ? h("span", { class: "chip cat" }, a.category) : null,
      h("span", { class: "pub", title: a.source_name ? `via ${a.source_name}` : "" }, a.publisher),
      h("span", { title: fmtTime(a.published_at) }, ago(a.published_at)));

    const actions = h("div", { class: "actions" },
      h("button", { class: "btn ghost sm" + (a.is_pinned ? " on" : ""), title: "스크랩", onclick: () => patch({ is_pinned: a.is_pinned ? 0 : 1 }, a.is_pinned ? "스크랩 해제" : "스크랩했습니다") }, a.is_pinned ? "스크랩됨" : "스크랩"),
      h("button", { class: "btn ghost sm" + (a.feedback > 0 ? " on" : ""), title: "유용함 — 이 소스 가중치가 조금 올라갑니다", onclick: () => patch({ feedback: a.feedback > 0 ? 0 : 1 }) }, "유용함 ↑"),
      h("button", { class: "btn ghost sm" + (a.feedback < 0 ? " on-warn" : ""), title: "관심 없음 — 점수를 낮춥니다", onclick: () => patch({ feedback: a.feedback < 0 ? 0 : -1 }) }, "관심 없음 ↓"),
      h("button", { class: "btn ghost sm", title: "적용 아이디어 메모", onclick: () => { noteOpen = !noteOpen; render(); if (noteOpen) root.querySelector("textarea")?.focus(); } }, a.note ? "메모 수정" : "메모"),
      relatedCount ? h("button", { class: "btn ghost sm", onclick: toggleRelated }, `관련 기사 ${relatedCount} ${relOpen ? "−" : "+"}`) : null,
      h("button", { class: "btn ghost sm" + (a.is_hidden ? " on-warn" : ""), title: "브리핑에서 숨기기", onclick: () => patch({ is_hidden: a.is_hidden ? 0 : 1 }, a.is_hidden ? "다시 표시합니다" : "숨겼습니다") }, a.is_hidden ? "숨김 해제" : "숨기기"));

    const noteBox = noteOpen ? h("div", { class: "note-box" },
      h("textarea", { placeholder: "우리 팀 적용 아이디어, 후속 조치 등을 적어두세요 (스크랩에 함께 저장)", value: a.note || "" }),
      h("div", { class: "form-row", style: "margin-top:6px;justify-content:flex-end" },
        h("button", { class: "btn sm", onclick: () => { noteOpen = false; render(); } }, "취소"),
        h("button", { class: "btn primary sm", onclick: (e) => { const v = e.target.closest(".note-box").querySelector("textarea").value; noteOpen = false; patch({ note: v, is_pinned: v.trim() ? 1 : a.is_pinned }, "메모를 저장했습니다"); } }, "저장"))) : null;
    const noteView = !noteOpen && a.note ? h("div", { class: "note-view" }, "— " + a.note) : null;

    const related = relOpen && a.related ? h("ul", { class: "related" }, a.related.map((r) =>
      h("li", {}, h("span", { class: "pub" }, r.publisher), h("a", { href: safeUrl(r.url), target: "_blank", rel: "noopener noreferrer" }, r.title)))) : null;

    const body = [title,
      a.summary ? h("div", { class: "summary" }, a.summary) : null,
      keywordChips(a.matched || []), noteView, actions];

    if (variant === "top") {
      root.append(
        h("div", { class: "rank" }, h("b", {}, String(rank).padStart(2, "0")), left),
        h("div", { class: "body", style: "min-width:0" }, body, noteBox, related),
        h("div", { class: "score-col" }, scoreBadge(a.score)));
    } else {
      root.append(...[left, h("div", { style: "min-width:0" }, body), h("div", { class: "side" }, scoreBadge(a.score)), noteBox, related].filter(Boolean));
      if (noteOpen || relOpen) root.classList.add("open"); else root.classList.remove("open");
    }
  }
  render();
  return root;
}

/* ================= 뷰: 브리핑 ================= */
const briefingState = { date: null, hours: "" };

async function viewBriefing() {
  await config();
  const q = new URLSearchParams();
  if (briefingState.date) q.set("date", briefingState.date);
  if (briefingState.hours) q.set("hours", briefingState.hours);
  const b = await api("briefing?" + q);
  const d = new Date(b.date + "T00:00:00");
  const allItems = [...b.top, ...b.sections.flatMap((s) => s.items)];

  const dateInput = h("input", { type: "date", value: b.date, max: todayStr(), onchange: (e) => { briefingState.date = e.target.value === todayStr() ? null : e.target.value; route(); } });
  const hoursSel = h("select", { onchange: (e) => { briefingState.hours = e.target.value; route(); } },
    [["", `자동 (${b.hours}시간)`], ["24", "지난 24시간"], ["72", "지난 3일"], ["168", "지난 7일"]].map(([v, t]) =>
      h("option", { value: v, selected: briefingState.hours === v }, t)));

  const head = [
    h("section", { class: "hero" },
      h("div", { class: "eyebrow" }, "플랜트설계 AX 모닝 브리핑"),
      h("h1", {}, d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }), h("br"), d.toLocaleDateString("ko-KR", { weekday: "long" })),
      h("div", { class: "hero-side" },
        h("div", { class: "stats-line" },
          h("span", {}, "수집 ", h("b", {}, b.stats.collected)),
          h("span", {}, "사건 ", h("b", {}, b.stats.events)),
          h("span", {}, "선별 ", h("b", {}, b.stats.shown))),
        h("div", { class: "eyebrow", style: "margin-top:8px" }, `마지막 수집 ${b.last_run ? ago(b.last_run) : "없음"}`))),
    h("div", { class: "tools-bar" }, dateInput, hoursSel,
      h("button", { class: "btn", onclick: async () => { await api("articles/read", { method: "POST", body: { ids: allItems.map((x) => x.id) } }); toast("모두 읽음으로 표시했습니다"); route(); } }, "모두 읽음"),
      h("a", { class: "btn", href: STATIC ? `data/briefing/${b.date}_${briefingState.hours || "auto"}.md` : "/api/briefing/export?" + q, download: "" }, "마크다운 내보내기 ↓")),
  ];

  if (!allItems.length) {
    return [...head, h("div", { class: "empty" },
      b.last_run ? "이 기간에는 기준 점수를 넘는 기사가 없습니다. 기간을 늘리거나 설정에서 기준 점수를 낮춰보세요."
                 : "아직 수집한 기사가 없습니다. 왼쪽 아래 ‘지금 수집’을 눌러주세요.",
      h("div", { style: "margin-top:14px" }, h("button", { class: "btn", onclick: () => { briefingState.hours = "168"; route(); } }, "지난 7일로 보기")))];
  }

  const top = b.top.length ? [
    h("div", { class: "section-head" }, h("h2", {}, "오늘의 핵심"), h("span", { class: "count" }, `${b.top.length}`)),
    h("div", { class: "top-grid" }, b.top.map((a, i) => articleEl(a, { variant: "top", rank: i + 1 })))] : [];

  const sections = b.sections.map((s) => h("section", { class: "section" },
    h("div", { class: "section-head" }, h("h2", {}, s.name), h("span", { class: "count" }, `${s.items.length}`)),
    h("div", { class: "list-wrap" }, s.items.map((a) => articleEl(a, { showCat: false })))));

  return [...head, ...top, ...sections];
}

/* ================= 뷰: 전체 기사 / 스크랩 ================= */
const listState = { q: "", category: "", source_id: "", days: "7", min_score: "", sort: "score", group: true, unread: false, hidden: false, page: 1 };

async function viewArticles(pinnedOnly = false) {
  const cfg = await config();
  const sources = await api("sources");
  const st = pinnedOnly ? { page: listState.pinnedPage || 1, pinned: "1", sort: "date" } : listState;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(st)) {
    if (v === true) q.set(k, "1");
    else if (v !== false && v !== "" && v != null) q.set(k, v);
  }
  if (pinnedOnly) q.delete("days");
  const data = await api("articles?" + q);

  const set = (k) => (e) => { listState[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; listState.page = 1; route(); };
  let searchTimer;
  const filters = pinnedOnly ? null : h("div", { class: "filters" },
    h("input", { type: "search", placeholder: "제목·요약·메모 검색", value: listState.q, oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listState.q = e.target.value; listState.page = 1; route(true); }, 350); } }),
    h("select", { onchange: set("category") }, h("option", { value: "" }, "모든 카테고리"),
      [...cfg.categories.map((c) => c.name), "기타"].map((n) => h("option", { value: n, selected: listState.category === n }, n))),
    h("select", { onchange: set("source_id") }, h("option", { value: "" }, "모든 소스"),
      sources.map((s) => h("option", { value: s.id, selected: String(listState.source_id) === String(s.id) }, s.name))),
    h("select", { onchange: set("days") }, [["1", "24시간"], ["3", "3일"], ["7", "7일"], ["30", "30일"], ["", "전체 기간"]].map(([v, t]) => h("option", { value: v, selected: listState.days === v }, t))),
    h("select", { onchange: set("min_score") }, [["", "점수 전체"], ["2", "2점 이상"], ["3.5", "3.5점 이상"], ["5", "5점 이상"]].map(([v, t]) => h("option", { value: v, selected: listState.min_score === v }, t))),
    h("select", { onchange: set("sort") }, [["score", "점수순"], ["date", "최신순"]].map(([v, t]) => h("option", { value: v, selected: listState.sort === v }, t))),
    h("label", { class: "check", title: "같은 사건을 다룬 여러 매체 기사 중 대표 1건만 표시" }, h("input", { type: "checkbox", checked: listState.group, onchange: set("group") }), "사건별로 묶기"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: listState.unread, onchange: set("unread") }), "안 읽은 것만"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: listState.hidden, onchange: set("hidden") }), "숨긴 기사"));

  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const goto = (p) => { if (pinnedOnly) listState.pinnedPage = p; else listState.page = p; route(); window.scrollTo(0, 0); };
  const pager = pages > 1 ? h("div", { class: "pager" },
    h("button", { class: "btn sm", disabled: data.page <= 1, onclick: () => goto(data.page - 1) }, "이전"),
    `${data.page} / ${pages}`,
    h("button", { class: "btn sm", disabled: data.page >= pages, onclick: () => goto(data.page + 1) }, "다음")) : null;

  const head = h("div", { class: "page-head" },
    h("div", {},
      h("h1", {}, pinnedOnly ? "스크랩" : "전체 기사"),
      h("div", { class: "sub" }, pinnedOnly ? `저장한 기사 ${data.total}건 · 메모를 남기면 보고서 작성 때 바로 활용할 수 있습니다` : `${data.total.toLocaleString()}건`)));

  const list = data.items.length
    ? h("div", { class: "list-wrap" }, data.items.map((a) => articleEl(a, { onChange: (x, body) => { if (pinnedOnly && body.is_pinned === 0) route(); } })))
    : h("div", { class: "empty" },
        pinnedOnly ? "아직 스크랩한 기사가 없습니다. 기사에 마우스를 올려 ‘스크랩’이나 ‘메모’를 눌러 저장하세요." : "조건에 맞는 기사가 없습니다.");
  return [head, filters, list, pager];
}

/* ================= 뷰: 트렌드 ================= */
const PALETTE = ["var(--c0)", "var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)"];

async function viewTrends() {
  const t = await api("trends");
  const max = Math.max(1, ...t.keywords.map((k) => Math.max(k.this, k.prev)));
  const kwPanel = h("div", { class: "panel" },
    h("h2", {}, "키워드 — 최근 7일 vs 그 전 7일"),
    h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:var(--ink)" }), "최근 7일"), h("span", {}, h("i", { style: "background:var(--ink-4)" }), "그 전 7일")),
    t.keywords.length ? t.keywords.map((k) => {
      const d = k.this - k.prev;
      const pct = k.prev ? Math.round((d / k.prev) * 100) : null;
      return h("div", { class: "kw-row" },
        h("div", { class: "name", title: k.keyword }, k.keyword),
        h("div", { class: "kw-bars" },
          h("div", { class: "b", style: `width:${(k.this / max) * 100}%`, title: `최근 7일 ${k.this}건` }),
          h("div", { class: "b prev", style: `width:${(k.prev / max) * 100}%`, title: `그 전 7일 ${k.prev}건` })),
        h("div", { class: "delta " + (d > 0 ? "up" : d < 0 ? "down" : "") }, pct == null ? (k.this ? "NEW" : "") : `${d >= 0 ? "+" : ""}${pct}%`));
    }) : h("div", { class: "muted" }, "데이터가 쌓이면 표시됩니다."));

  const totals = t.daily.map((d) => t.categories.reduce((s, c) => s + d[c], 0));
  const dmax = Math.max(1, ...totals);
  const chart = h("div", { class: "panel" },
    h("h2", {}, "카테고리별 관련 기사 수 — 최근 14일"),
    h("div", { class: "legend" }, t.categories.map((c, i) => h("span", {}, h("i", { style: `background:${PALETTE[i % PALETTE.length]}` }), c))),
    h("div", { class: "stack-chart" }, t.daily.map((d, di) => h("div", { class: "stack-col", title: `${d.day} · ${totals[di]}건\n` + t.categories.filter((c) => d[c]).map((c) => `${c} ${d[c]}`).join("\n") },
      t.categories.map((c, i) => d[c] ? h("div", { class: "seg", style: `height:${(d[c] / dmax) * 100}%;background:${PALETTE[i % PALETTE.length]}` }) : null)))),
    h("div", { class: "stack-labels" }, t.daily.map((d, i) => h("span", {}, i % 2 ? "" : d.day))));

  const pubs = h("div", { class: "panel" }, h("h2", {}, "많이 다룬 매체 — 최근 7일"),
    t.publishers.length ? t.publishers.map(([p, n]) => h("div", { class: "pub-row" }, h("span", {}, p), h("b", {}, n))) : h("div", { class: "muted" }, "-"));

  return [h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "트렌드"), h("div", { class: "sub" }, "점수 2점 이상 기사 기준 · 숨긴 기사 제외"))),
    h("div", { class: "trend-grid" }, chart, kwPanel, pubs)];
}

/* ================= 뷰: 소스 관리 ================= */
const srcForm = { mode: "gnews", name: "", url: "", query: "", lang: "ko", tier: "1", category: "", test: null };

async function viewSourcesReadOnly() {
  const sources = await api("sources");
  const on = sources.filter((s) => s.enabled);
  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "소스"), h("div", { class: "sub" }, `켜진 소스 ${on.length}개 · 소스 추가·수정은 Mac 앱에서 할 수 있습니다`))),
    h("div", { class: "list-wrap" }, on.map((s) => h("article", { class: "item" },
      h("div", { class: "left" }, h("span", { class: "chip cat" }, `T${s.tier} · ${s.category || "자동"}`), h("span", {}, `7일 ${s.week_count}건`)),
      h("div", { style: "min-width:0" }, h("div", { class: "title" }, s.name), h("div", { class: "meta" }, s.last_status || "")),
      h("div", { class: "side" }, h("span", { class: "score" }, s.last_fetched ? ago(s.last_fetched) : "")))))];
}

async function viewSettingsReadOnly() {
  const cfg = await config();
  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "설정"), h("div", { class: "sub" }, "공개 사이트는 Mac 앱이 게시한 결과를 보여줍니다"))),
    h("div", { class: "empty" }, "키워드·카테고리·점수 기준을 바꾸려면 Mac 앱(127.0.0.1:8765)의 설정을 이용하세요.", h("br"),
      h("span", { style: "font-size:14px" }, `현재 브리핑 기준 ${cfg.settings.briefing_threshold}점 · 핵심 기사 ${cfg.settings.top_n}건 · 스크랩·메모는 이 기기 브라우저에만 저장됩니다`))];
}

async function viewSources() {
  const cfg = await config();
  const sources = await api("sources");
  const catOptions = (sel) => [h("option", { value: "" }, "(자동)"), ...cfg.categories.map((c) => h("option", { value: c.name, selected: sel === c.name }, c.name))];
  const tierOptions = (sel) => [["1", "T1 플랜트"], ["2", "T2 AI"], ["3", "T3 연구"]].map(([v, t]) => h("option", { value: v, selected: String(sel) === v }, t));

  const gnewsUrl = () => {
    const q = encodeURIComponent(`${srcForm.query} when:7d`);
    return srcForm.lang === "ko" ? `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`
                                 : `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  };
  const currentUrl = () => (srcForm.mode === "gnews" ? (srcForm.query.trim() ? gnewsUrl() : "") : srcForm.url.trim());

  const bind = (k) => (e) => { srcForm[k] = e.target.value; };
  const form = h("div", { class: "panel add-source" },
    h("div", { class: "form-row", style: "justify-content:space-between" },
      h("h2", { style: "margin:0" }, "소스 추가"),
      h("div", { class: "seg-ctl" },
        h("button", { class: srcForm.mode === "gnews" ? "on" : "", onclick: () => { srcForm.mode = "gnews"; srcForm.test = null; route(); } }, "Google News 키워드"),
        h("button", { class: srcForm.mode === "rss" ? "on" : "", onclick: () => { srcForm.mode = "rss"; srcForm.test = null; route(); } }, "RSS / Atom 주소"))),
    srcForm.mode === "gnews"
      ? h("div", { class: "form-row" },
          h("input", { type: "text", placeholder: '검색어 — 예: "P&ID" AI, (삼성E&A OR 현대엔지니어링) 디지털', value: srcForm.query, oninput: bind("query") }),
          h("select", { onchange: bind("lang") }, h("option", { value: "ko", selected: srcForm.lang === "ko" }, "한국어 뉴스"), h("option", { value: "en", selected: srcForm.lang === "en" }, "영어 뉴스")))
      : h("div", { class: "form-row" }, h("input", { type: "url", placeholder: "https://example.com/feed.xml", value: srcForm.url, oninput: bind("url") })),
    h("div", { class: "form-row" },
      h("input", { type: "text", placeholder: "표시 이름 (비우면 자동)", value: srcForm.name, oninput: bind("name"), style: "flex:1 1 200px" }),
      h("select", { onchange: bind("tier") }, tierOptions(srcForm.tier)),
      h("select", { onchange: bind("category"), title: "키워드로 분류가 안 될 때 쓸 기본 카테고리" }, catOptions(srcForm.category)),
      h("button", { class: "btn", onclick: async (e) => {
        const url = currentUrl(); if (!url) return toast("주소나 검색어를 입력하세요", true);
        e.target.disabled = true; e.target.textContent = "확인 중…";
        try { srcForm.test = await api("sources/test", { method: "POST", body: { url } }); }
        catch (err) { srcForm.test = { error: err.message }; }
        route();
      } }, "미리보기"),
      h("button", { class: "btn primary", onclick: async () => {
        const url = currentUrl(); if (!url) return toast("주소나 검색어를 입력하세요", true);
        try {
          const body = { name: srcForm.name || (srcForm.mode === "gnews" ? `GN · ${srcForm.query}` : ""), url, tier: +srcForm.tier, category: srcForm.category };
          const s = await api("sources", { method: "POST", body });
          Object.assign(srcForm, { name: "", url: "", query: "", test: null });
          toast(`‘${s.name}’ 추가 — 수집을 시작합니다`);
          await api("collect", { method: "POST", body: { source_ids: [s.id] } });
          pollStatus(); route();
        } catch (err) { toast(err.message, true); }
      } }, "추가")),
    srcForm.test ? h("div", { class: "test-result" },
      srcForm.test.error ? h("span", { class: "st-err", style: "max-width:none;white-space:normal" }, "가져오기 실패: " + srcForm.test.error)
        : [h("b", {}, `${srcForm.test.count}건을 가져올 수 있습니다.`), srcForm.test.samples.length ? h("ol", {}, srcForm.test.samples.map((s) => h("li", {}, s.title, h("span", { class: "muted" }, s.published ? `  · ${ago(s.published)}` : "")))) : null]) : null);

  const upd = (s, body) => api(`sources/${s.id}`, { method: "PATCH", body }).then(() => { toast("저장했습니다"); CONFIG = null; }).catch((e) => toast(e.message, true));
  const rows = sources.map((s) => {
    const ok = (s.last_status || "").startsWith("OK");
    return h("tr", { class: s.enabled ? "" : "off" },
      h("td", {}, h("label", { class: "switch", title: s.enabled ? "켜짐" : "꺼짐" }, h("input", { type: "checkbox", checked: !!s.enabled, onchange: async (e) => { await upd(s, { enabled: e.target.checked ? 1 : 0 }); route(); } }), h("span"))),
      h("td", { style: "min-width:220px" },
        h("div", { class: "src-name" }, h("span", { class: "tier-tag" }, `T${s.tier}`), s.name),
        h("div", { class: "src-url", title: s.url }, s.url)),
      h("td", {}, h("select", { onchange: (e) => upd(s, { tier: +e.target.value }) }, tierOptions(s.tier))),
      h("td", {}, h("select", { onchange: (e) => upd(s, { category: e.target.value }) }, catOptions(s.category))),
      h("td", {}, h("input", { type: "number", step: "0.05", min: "0.5", max: "1.5", value: (+s.weight).toFixed(2), title: "가중치 (👍/👎로 자동 조정, 0.5~1.5)", onchange: (e) => upd(s, { weight: +e.target.value }) })),
      h("td", { class: "num" }, s.week_count, h("div", { class: "muted", style: "font-size:11px" }, `누적 ${s.article_count}`)),
      h("td", {}, s.last_status ? h("span", { class: ok ? "st-ok" : "st-err", title: s.last_status }, ok ? s.last_status.slice(5) : `오류 · ${s.last_status}`) : h("span", { class: "muted" }, "대기"),
        h("div", { class: "muted", style: "font-size:11px" }, s.last_fetched ? ago(s.last_fetched) : "")),
      h("td", { style: "white-space:nowrap" },
        h("button", { class: "btn ghost sm", title: "이 소스만 지금 수집", onclick: async () => { await api("collect", { method: "POST", body: { source_ids: [s.id] } }); pollStatus(); toast(`‘${s.name}’ 수집 시작`); } }, "수집"),
        h("button", { class: "btn ghost sm danger", title: "삭제", onclick: async () => {
          if (!confirm(`‘${s.name}’ 소스를 삭제할까요?\n(스크랩하지 않은 이 소스의 기사도 함께 삭제됩니다)`)) return;
          await api(`sources/${s.id}?articles=1`, { method: "DELETE" }); toast("삭제했습니다"); route();
        } }, "삭제")));
  });

  const byTier = [1, 2, 3].map((t) => sources.filter((s) => s.tier === t && s.enabled).length);
  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "소스 관리"),
      h("div", { class: "sub" }, `켜진 소스 ${byTier.reduce((a, b) => a + b, 0)}개 · T1 플랜트/EPC ${byTier[0]} · T2 AI 기술 ${byTier[1]} · T3 연구·정책 ${byTier[2]}`))),
    form,
    h("div", { class: "panel" }, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ["", "소스", "등급", "기본 카테고리", "가중치", "7일 건수", "상태", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows)))),
  ];
}

/* ================= 뷰: 설정 ================= */
async function viewSettings() {
  CONFIG = await api("config");
  const cfg = structuredClone(CONFIG);
  const lines = (arr) => arr.join("\n");
  const parse = (txt) => txt.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  const num = (key, label, hint, step = "1") => h("label", { class: "field" },
    h("span", { class: "lbl" }, label),
    h("input", { type: "number", step, value: cfg.settings[key], oninput: (e) => { cfg.settings[key] = +e.target.value; } }),
    h("span", { class: "hint" }, hint));

  const txt = (key, label, hint, placeholder = "") => h("label", { class: "field" },
    h("span", { class: "lbl" }, label),
    h("input", { type: "text", value: cfg.settings[key] || "", placeholder, oninput: (e) => { cfg.settings[key] = e.target.value.trim(); } }),
    h("span", { class: "hint" }, hint));

  const kwArea = (key, label, hint) => h("label", { class: "field" },
    h("span", { class: "lbl" }, `${label} (${(cfg.keywords[key] || []).length})`),
    h("textarea", { rows: 9, value: lines(cfg.keywords[key] || []), oninput: (e) => { cfg.keywords[key] = parse(e.target.value); } }),
    h("span", { class: "hint" }, hint));

  const catList = h("div", {});
  const renderCats = () => {
    catList.replaceChildren(...cfg.categories.map((c, i) => h("div", { class: "cat-edit" },
      h("input", { type: "text", value: c.icon, title: "아이콘", oninput: (e) => { c.icon = e.target.value; } }),
      h("input", { type: "text", value: c.name, title: "이름", oninput: (e) => { c.name = e.target.value; } }),
      h("textarea", { rows: 2, value: lines(c.keywords), oninput: (e) => { c.keywords = parse(e.target.value); } }),
      h("button", { class: "btn ghost sm danger", onclick: () => { cfg.categories.splice(i, 1); renderCats(); } }, "삭제"))));
  };
  renderCats();

  const save = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("config", { method: "PUT", body: cfg });
      CONFIG = r;
      toast(`저장했습니다 — 기사 ${r.rescored}건 점수를 다시 계산했습니다`);
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
  };

  return [
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "설정"), h("div", { class: "sub" }, "저장하면 최근 기사 점수·카테고리를 즉시 다시 계산합니다"))),
    h("div", { class: "panel" }, h("h2", {}, "수집·브리핑"),
      h("div", { class: "settings-grid" },
        num("collect_interval_hours", "자동 수집 간격 (시간)", "앱이 켜져 있는 동안 반복 수집 · 0이면 끔", "0.5"),
        num("briefing_threshold", "브리핑 기준 점수", "이 점수 이상만 플랜트 관련 섹션에 표시", "0.1"),
        num("ai_general_threshold", "‘AI모델·도구’ 기준 점수", "일반 AI 동향은 도메인 키워드가 없어 점수가 낮음", "0.1"),
        num("top_n", "핵심 기사 수", "브리핑 맨 위 ‘오늘의 핵심’ 개수"),
        num("max_article_age_days", "최대 기사 나이 (일)", "이보다 오래된 기사는 수집하지 않음"),
        num("retention_days", "보관 기간 (일)", "지나면 삭제 (스크랩은 유지)"),
        num("dedup_similarity", "같은 사건 판정 유사도", "0~1 · 낮을수록 더 많이 묶음 (권장 0.45~0.6)", "0.05"))),
    h("div", { class: "panel" }, h("h2", {}, "공개 사이트 게시"),
      h("div", { class: "settings-grid" },
        txt("publish_repo", "게시 저장소", "수집이 끝날 때마다 이 GitHub 저장소(Pages)에 브리핑을 올립니다 · 비우면 게시 안 함", "계정/저장소"),
        h("div", { class: "field" }, h("span", { class: "lbl" }, "게시 상태"),
          h("span", { class: "hint", id: "publish-status", style: "font-size:13px" }, "…"),
          h("button", { class: "btn", style: "align-self:flex-start;margin-top:6px", onclick: async () => {
            await api("config", { method: "PUT", body: { settings: cfg.settings } });
            await api("publish", { method: "POST", body: {} });
            toast("사이트 게시를 시작했습니다"); setTimeout(refreshStats, 1500);
          } }, "지금 게시 ↗")))),
    h("div", { class: "panel" }, h("h2", {}, "점수 키워드"),
      h("p", { class: "muted", style: "margin:-6px 0 14px;font-size:13px" }, "한 줄에 하나(또는 쉼표로 구분). 영문은 단어 단위로, 한글은 부분 일치로 찾습니다. 제목에 있으면 요약보다 2배로 계산합니다."),
      h("div", { class: "kw-groups" },
        kwArea("domain", "핵심 도메인", "플랜트 설계와 직접 관련 — 제목 2점 / 요약 1점, 최대 6점"),
        kwArea("domain_weak", "보조 도메인", "업계 일반 용어 — 제목 1점 / 요약 0.5점"),
        kwArea("ai", "AI·자동화", "도메인 키워드와 같이 나오면 +2점 가산"),
        kwArea("exclude", "제외어", "포함되면 크게 감점되어 브리핑에서 빠짐"))),
    h("div", { class: "panel" }, h("h2", {}, "카테고리"),
      h("p", { class: "muted", style: "margin:-6px 0 8px;font-size:13px" }, "키워드가 가장 많이 맞는 카테고리로 분류됩니다. 순서대로 브리핑에 표시됩니다."),
      catList,
      h("button", { class: "btn sm", style: "margin-top:18px", onclick: () => { cfg.categories.push({ name: "새 카테고리", icon: "", keywords: [] }); renderCats(); } }, "+ 카테고리 추가")),
    h("div", { class: "save-bar" },
      h("button", { class: "btn ghost danger", onclick: async () => { if (!confirm("키워드·카테고리·설정을 기본값으로 되돌릴까요? (소스와 기사는 유지)")) return; CONFIG = await api("config/reset", { method: "POST", body: {} }); toast("기본값으로 되돌렸습니다"); route(); } }, "기본값으로"),
      h("button", { class: "btn primary", onclick: save }, "저장하고 점수 다시 계산")),
  ];
}

/* ================= 라우팅 · 상태 ================= */
const VIEWS = { briefing: viewBriefing, articles: () => viewArticles(false), pinned: () => viewArticles(true), trends: viewTrends,
  sources: STATIC ? viewSourcesReadOnly : viewSources, settings: STATIC ? viewSettingsReadOnly : viewSettings };
let routeSeq = 0;

async function route(keepFocus = false) {
  const name = (location.hash.slice(1) || "briefing");
  const fn = VIEWS[name] || viewBriefing;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  const seq = ++routeSeq;
  const focused = keepFocus ? document.activeElement : null;
  const caret = focused?.selectionStart;
  try {
    const nodes = [await fn()].flat().filter(Boolean);
    if (seq !== routeSeq) return;
    const scroll = window.scrollY;
    // 처음 그릴 때만 위에서부터 순서대로 떠오르는 효과
    if (!keepFocus) nodes.forEach((n, i) => { n.classList?.add("reveal"); n.style?.setProperty("--i", Math.min(i, 8)); });
    view.replaceChildren(...nodes);
    if (keepFocus) {
      window.scrollTo(0, scroll);
      const s = view.querySelector("input[type=search]");
      if (s && focused?.type === "search") { s.focus(); s.setSelectionRange(caret, caret); }
    }
  } catch (e) {
    view.replaceChildren(h("div", { class: "empty" }, "불러오지 못했습니다 — " + e.message));
  }
}

/* ---- 전체 화면 메뉴 ---- */
const menu = $("#menu"), menuBtn = $("#menu-btn");
function setMenu(open) {
  if (open) menu.hidden = false;
  requestAnimationFrame(() => menu.classList.toggle("open", open));
  document.body.classList.toggle("menu-open", open);
  menuBtn.setAttribute("aria-expanded", open);
  $("#menu-label").textContent = open ? "Close" : "Menu";
  if (open) refreshStats();
}
menuBtn.addEventListener("click", () => setMenu(!menu.classList.contains("open")));
menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.classList.contains("open")) setMenu(false); });

/* ---- 수집 상태 ---- */
let pollTimer = null, wasRunning = false;
async function refreshStats() {
  try {
    const s = await api("stats");
    const st = s.status;
    $("#nav-unread").textContent = s.unread_today || "";
    $("#nav-pinned").textContent = s.pinned || "";
    for (const btn of [$("#btn-collect"), $("#btn-collect-2")]) {
      btn.disabled = st.running;
      btn.firstChild.textContent = STATIC ? "새로 불러오기 " : st.running ? "수집 중 " : "지금 수집 ";
    }
    const prog = $("#collect-progress");
    prog.hidden = !st.running;
    $("#status-dot").classList.toggle("busy", st.running);
    if (st.running) prog.firstElementChild.style.width = `${st.total ? (st.done / st.total) * 100 : 5}%`;
    $("#collect-status").textContent = st.running
      ? `${st.message} (${st.done}/${st.total})`
      : `${st.last_run ? "마지막 수집 " + ago(st.last_run) : "아직 수집 전"} · 기사 ${s.articles.toLocaleString()}건 · 소스 ${s.sources}개`
        + (st.message ? `\n${st.message}` : "") + (st.publish ? `\n${st.publish}` : "");
    const ps = $("#publish-status");
    if (ps) ps.textContent = st.publish || "아직 게시 전";
    $(".corner-right").title = $("#collect-status").textContent;
    if (wasRunning && !st.running) { toast(st.message || "수집 완료"); route(true); }
    wasRunning = st.running;
    return st.running;
  } catch { return false; }
}

function pollStatus() {
  clearTimeout(pollTimer);
  const tick = async () => { const running = await refreshStats(); pollTimer = setTimeout(tick, running ? 1000 : 30000); };
  tick();
}

async function startCollect() {
  if (STATIC) { jsonCache = {}; await route(true); refreshStats(); toast("최신 게시 데이터를 불러왔습니다"); return; }
  const r = await api("collect", { method: "POST", body: {} });
  if (!r.started) toast(r.message || "이미 수집 중입니다");
  wasRunning = true;
  pollStatus();
}
$("#btn-collect").addEventListener("click", startCollect);
$("#btn-collect-2").addEventListener("click", startCollect);
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

/* ---- 인트로: 0 → 100 카운터 (세션당 한 번) ---- */
(async function boot() {
  const intro = $("#intro");
  let seen = false;
  try { seen = sessionStorage.getItem("introSeen") === "1"; sessionStorage.setItem("introSeen", "1"); } catch {}
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const first = route();
  if (seen || reduce) { intro.remove(); } else {
    const count = $("#intro-count"), t0 = performance.now(), dur = 1300;
    await new Promise((done) => {
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        count.textContent = Math.round((1 - Math.pow(1 - p, 3)) * 100);
        p < 1 ? requestAnimationFrame(step) : done();
      };
      requestAnimationFrame(step);
    });
    await first;
    intro.classList.add("done");
    setTimeout(() => intro.remove(), 1000);
  }
  pollStatus();
})();
