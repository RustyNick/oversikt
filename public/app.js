"use strict";

/* =====================================================================
   1. DATA SOURCE
   ===================================================================== */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      "Can’t reach the server. Check that it is running (npm start).",
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed (" + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return data;
}
const DataSource = {
  getSaved: () => api("GET", "/api/users"),
  getUser: (login) => api("GET", "/api/users/" + login),
  getStreams: (login) => api("GET", "/api/users/" + login + "/streams"),
  fetchNow: (login) => api("POST", "/api/users/" + login + "/fetch"),
  setSaved: (login, saved) =>
    api("PUT", "/api/users/" + login + "/saved", { saved }),
  getTimeline: (login, id) =>
    api(
      "GET",
      "/api/users/" +
        login +
        "/streams/" +
        encodeURIComponent(id) +
        "/timeline",
    ),
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const NO_CATEGORY = "Unknown category";

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function dow(d) {
  return (d.getDay() + 6) % 7;
} // Monday = 0
const TODAY = startOfDay(new Date());
function hash(str) {
  let h = 2166136261;
  for (const c of str) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Turns the backend's rows into what the views use
function toStreams(rows) {
  return rows
    .map((r) => {
      const at = new Date(r.startedAt);
      return {
        id: r.id,
        at,
        date: startOfDay(at),
        start:
          String(at.getHours()).padStart(2, "0") +
          ":" +
          String(at.getMinutes()).padStart(2, "0"),
        dur: r.durationMin,
        cat: r.category || NO_CATEGORY,
        catImg: r.categoryImage,
        max: r.maxViewers,
        avg: r.avgViewers,
        foll: r.followersGained,
        hw: r.hoursWatched,
      };
    })
    .sort((a, b) => b.at - a.at);
}

/* =====================================================================
   2. STATE + STORAGE
   ===================================================================== */
const ACCENTS = [
  "#FF5714",
  "#B91372",
  "#03D205",
  "#12A5A5",
  "#C02BD8",
  "#FFB800",
];
const ACCENT_NAMES = [
  "Tiger flame",
  "Magenta",
  "Green",
  "Teal",
  "Purple",
  "Amber",
];
// day = how several streams on the same day are combined in the chart
const METRICS = [
  { k: "max", label: "Max Viewers", dec: 0, day: (a) => highest(a) },
  { k: "avg", label: "Avg. Viewers", dec: 0, day: (a) => mean(a) },
  { k: "foll", label: "Followers Gained", dec: 0, day: (a) => sum(a) },
  { k: "hw", label: "Hours Watched", dec: 1, day: (a) => sum(a) },
];
const SAVED_PAGE = 5; // saved users shown per "Load more"
const CATS_SHOWN = 3; // categories shown before "See more"
const S = {
  view: "start",
  user: null,
  streams: [],
  tab: "overview",
  day: dow(TODAY),
  range: 4,
  weekOff: 0,
  cat: "all",
  catsOpen: false,
  sum: 0,
  metric: 0,
  pickerOpen: false,
  exportOpen: false,
  error: "",
  loading: "",
  busy: false,
  timelines: {},
  timelineLoading: {},
  tlShow: { viewers: true, followers: true },
  chartShow: { max: true, avg: true, foll: false, hw: false }, // figures ticked in the 30 Days and Weekly chart
  saved: [],
  savedShown: SAVED_PAGE,
  focus: null,
  accent: ACCENTS[0],
  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  themeChosen: false,
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable */
  }
}

/* ---- Contrast (WCAG 2.1) ---- */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function toHex(c) {
  return (
    "#" +
    c
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Moves a colour towards white or black in small steps until it has at least `min` contrast against every colour in `against`
function adjust(hex, against, min, toward) {
  const from = rgb(hex),
    to = rgb(toward);
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = toHex(from.map((v, i) => v + (to[i] - v) * t));
    if (against.every((x) => contrast(c, x) >= min)) return c;
  }
  return toward;
}
// Text colour for a background: Onyx or white, whichever has more contrast. Pure black if neither reaches 4.5:1.
function textOn(bg) {
  const best =
    contrast("#101012", bg) >= contrast("#FFFFFF", bg) ? "#101012" : "#FFFFFF";
  return contrast(best, bg) >= 4.5 ? best : "#000000";
}
function themeColour(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

// The viewer picks the accent. Each mode uses one accent: the chosen colour itself, made only as much
// darker (light mode) or lighter (dark mode) as needed for 3:1 contrast against the page and the
// surfaces. Strong colours usually stay exactly as chosen. Text on the accent gets at least 4.5:1.
function setAccent(hex) {
  S.accent = hex;
  const bg = themeColour("--bg", "#101012"),
    surface = themeColour("--surface", "#26262C");
  const toward = luminance(bg) < 0.5 ? "#FFFFFF" : "#000000";
  const accent = adjust(hex, [bg, surface], 3, toward);
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--on-accent", textOn(accent));
  store("oversikt.accent", hex);
}

// Light or dark mode. theme.js sets it from the system setting before the page is drawn.
// The page follows the system until the viewer uses the switch.
const systemDark = window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;
function setTheme(theme) {
  S.theme = theme;
  document.documentElement.dataset.theme = theme;
  setAccent(S.accent);
}

/* =====================================================================
   3. HELPERS
   ===================================================================== */
const $ = (sel) => document.querySelector(sel);
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const known = (a) => a.filter((v) => v != null); // drop values we have no data for
function mean(a) {
  a = known(a);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function sum(a) {
  a = known(a);
  return a.length ? a.reduce((x, y) => x + y, 0) : null;
}
function signed(v) {
  return v == null ? "–" : v > 0 ? "+" + v : v < 0 ? "−" + Math.abs(v) : "0";
}
function hours(v) {
  return v == null ? "–" : num(v, v >= 10 ? 0 : 1) + "h";
}
function highest(a) {
  a = known(a);
  return a.length ? Math.max(...a) : null;
}
function median(a) {
  a = known(a);
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function num(v, dec) {
  if (v == null) return "–";
  const f = Math.pow(10, dec || 0);
  return String(Math.round(v * f) / f);
}
function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60),
    m = min % 60;
  return h ? h + "h" + (m ? " " + m + "min" : "") : m + "min";
}
function fmtDurShort(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60),
    m = min % 60;
  return h ? h + "h" + (m ? " " + m + "m" : "") : m + "m";
}
function hhmm(d) {
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}
// Numbers in charts: 1000 and up are written 1k, 1.5k, 2k ...
function fmtK(v) {
  if (Math.abs(v) < 1000) return String(v);
  return String(Math.round(v / 100) / 10).replace(/\.0$/, "") + "k";
}
function fmtDate(d) {
  return d.getDate() + " " + MONTHS[d.getMonth()];
}
function shortMonth(d) {
  return MONTHS[d.getMonth()].slice(0, 3);
}
function fmtSpan(a, b) {
  return a.getMonth() === b.getMonth()
    ? a.getDate() + "–" + b.getDate() + " " + shortMonth(b)
    : a.getDate() +
        " " +
        shortMonth(a) +
        "–" +
        b.getDate() +
        " " +
        shortMonth(b);
}
function fmtWhen(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return (
    d.getDate() +
    " " +
    shortMonth(d) +
    " " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}
function isoDate(d) {
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}
function inRange(s, from, to) {
  return s.date >= from && s.date <= to;
}
function onDay(list, d) {
  return list.filter((s) => s.date.getTime() === d.getTime());
}
function initials(name) {
  const w = name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return ((w[0] || "?")[0] + (w[1] ? w[1][0] : "")).toUpperCase();
}
// Only pictures from Twitch's image server are shown. A picture that fails to load is removed
// (see the "error" listener at the bottom), so the letters underneath show instead.
function picture(url) {
  return typeof url === "string" &&
    url.startsWith("https://static-cdn.jtvnw.net/")
    ? '<img src="' + esc(url) + '" alt="" loading="lazy">'
    : "";
}
function avatar(u) {
  const colours = ["#FFE83D", "#7AD7F0", "#F7A8C4", "#B8E986", "#FFB86B"];
  return (
    '<span class="avatar" style="background:' +
    colours[hash(u.login) % colours.length] +
    '" aria-hidden="true">' +
    esc(u.login[0].toUpperCase()) +
    picture(u.avatar) +
    "</span>"
  );
}
function boxart(name, img) {
  return (
    '<span class="boxart" aria-hidden="true">' +
    esc(initials(name)) +
    picture(img) +
    "</span>"
  );
}

const ICON = {
  search:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6"/></svg>',
  palette:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20c1.4 0 2.2-1 2.2-2 0-.6-.2-1-.6-1.5-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a5 5 0 0 0 5-5C22 5.6 17.5 2 12 2zM6.5 12.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
  bookmark: (on) =>
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="' +
    (on ? "currentColor" : "none") +
    '" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',
  close:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  go: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle class="i-bg" cx="12" cy="12" r="10"/><path class="i-fg" d="M7.5 12h8M12.5 8.5L16 12l-3.5 3.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle class="i-bg" cx="12" cy="12" r="10"/><path class="i-fg" d="M16.5 12a4.5 4.5 0 1 1-1.4-3.3M16.5 7v2.5H14" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: (open) =>
    '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"' +
    (open ? ' style="transform:rotate(180deg)"' : "") +
    '><circle class="i-bg" cx="12" cy="12" r="10"/><path class="i-fg solid" d="M7.5 10l4.5 5 4.5-5z"/></svg>',
  sun: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  moon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/></svg>',
  chev: (dir) =>
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    (dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7") +
    '"/></svg>',
};

function trendIcon(delta, prev) {
  if (!delta)
    return '<svg class="trend" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>';
  const big = Math.abs(delta) >= Math.max(1, prev) * 0.5,
    up = delta > 0;
  const flip = up ? "" : ' transform="rotate(180 12 12)"';
  const paths = big
    ? '<path d="M6 12l6-6 6 6M6 19l6-6 6 6"/>'
    : '<path d="M6 15l6-6 6 6"/>';
  return (
    '<svg class="trend ' +
    (big ? (up ? "big-up" : "big-down") : "") +
    '" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g' +
    flip +
    ">" +
    paths +
    "</g></svg>"
  );
}

/* =====================================================================
   4. FILTERING: which streams does the current tab show?
   Returns the current period, the period before it (for the +/- figures)
   and the series for the chart.
   ===================================================================== */
function period() {
  const all = S.streams;
  const dayValue = (list, d, m) => {
    const v = m.day(onDay(list, d).map((s) => s[m.k])),
      f = Math.pow(10, m.dec);
    return v == null ? null : Math.round(v * f) / f;
  };
  if (S.tab === "weekly") {
    const monday = addDays(TODAY, -dow(TODAY) + S.weekOff * 7),
      sunday = addDays(monday, 6);
    const cur = all.filter((s) => inRange(s, monday, sunday));
    const prev = all.filter((s) =>
      inRange(s, addDays(monday, -7), addDays(monday, -1)),
    );
    return {
      cur,
      prev,
      dates: DAYS.map((_, i) => addDays(monday, i)),
      chart: (m) => ({
        type: "bar",
        labels: DAYS,
        values: DAYS.map((_, i) => dayValue(cur, addDays(monday, i), m)),
      }),
      caption: "Week " + fmtSpan(monday, sunday),
      listTitle: S.weekOff
        ? "Past Streams That Week"
        : "Past Streams This Week",
      empty: S.weekOff
        ? "No streams saved for that week."
        : "No streams saved yet this week.",
      vs: "the week before",
    };
  }
  if (S.tab === "day" && S.range === "latest") {
    // The latest single stream on this weekday, compared with the one before it
    const onDay = all.filter((s) => dow(s.date) === S.day),
      latest = onDay[0],
      before = onDay[1];
    return {
      mode: "latest",
      latest,
      cur: latest ? [latest] : [],
      prev: before ? [before] : [],
      caption: latest ? fmtDate(latest.date) + ", " + latest.start : "",
      listTitle: "Latest " + DAYS_LONG[S.day] + " Stream",
      empty: "No streams saved on " + DAYS_LONG[S.day] + "s.",
      vs: "the " + DAYS_LONG[S.day] + " stream before",
    };
  }
  if (S.tab === "day") {
    const last = addDays(TODAY, -((dow(TODAY) - S.day + 7) % 7));
    const dates = [];
    for (let i = S.range * 2 - 1; i >= 0; i--)
      dates.push(addDays(last, -7 * i));
    const curDates = dates.slice(S.range),
      prevDates = dates.slice(0, S.range);
    const pick = (ds) =>
      all.filter((s) => ds.some((d) => d.getTime() === s.date.getTime()));
    const cur = pick(curDates),
      plural = DAYS_LONG[S.day] + "s";
    return {
      cur,
      prev: pick(prevDates),
      chart: (m) => ({
        type: "line",
        labels: curDates.map((d) => d.getDate()),
        values: curDates.map((d) => dayValue(cur, d, m) || 0),
      }),
      caption:
        plural + " " + fmtSpan(curDates[0], curDates[curDates.length - 1]),
      listTitle: "Past Streams Of " + plural,
      empty: "No streams saved for the past " + S.range + " " + plural + ".",
      vs: "the " + S.range + " " + plural + " before",
    };
  }
  // 30 days, optionally one category
  const from = addDays(TODAY, -29),
    byCat = (s) => S.cat === "all" || s.cat === S.cat;
  const cur = all.filter((s) => inRange(s, from, TODAY) && byCat(s));
  const prev = all.filter(
    (s) => inRange(s, addDays(from, -30), addDays(from, -1)) && byCat(s),
  );
  const days = [];
  for (let i = 0; i < 30; i++) days.push(addDays(from, i));
  return {
    cur,
    prev,
    dates: days,
    chart: (m) => ({
      type: "bar",
      labels: days.map((d) => d.getDate()),
      values: days.map((d) => dayValue(cur, d, m)),
    }),
    caption: fmtSpan(from, TODAY),
    listTitle: "Past Streams Last 30 Days",
    empty: "No streams saved in the last 30 days.",
    vs: "the 30 days before",
  };
}

// Weekdays (0 = Monday) this user has streamed on, in week order
function streamedDays() {
  const days = new Set(S.streams.map((s) => dow(s.date)));
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => days.has(d));
}
// Which weekday the Day tab opens on: today if they stream today, otherwise the day of their latest stream
function defaultDay() {
  const days = streamedDays();
  if (days.includes(dow(TODAY)) || !S.streams.length) return dow(TODAY);
  return dow(S.streams[0].date);
}

/* =====================================================================
   5. RENDERING
   ===================================================================== */
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1)))),
    n = x / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}

function chartSvg(c, metricLabel) {
  const W = 340,
    H = 226,
    L = 36,
    R = 10,
    T = 24,
    B = 30,
    n = c.values.length;
  const peak = Math.max(1, ...c.values.map((v) => v || 0));
  const step = niceStep(peak / 4),
    top = step * Math.max(4, Math.ceil(peak / step));
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const band = (W - L - R) / n,
    x = (i) => L + band * (i + 0.5);
  let g = "";
  for (let v = 0; v <= top; v += step)
    g +=
      '<line class="grid" x1="' +
      L +
      '" x2="' +
      (W - R) +
      '" y1="' +
      y(v) +
      '" y2="' +
      y(v) +
      '"/><text x="' +
      (L - 8) +
      '" y="' +
      (y(v) + 4.5) +
      '" text-anchor="end">' +
      fmtK(v) +
      "</text>";
  const every = n <= 12 ? 1 : Math.ceil(n / 6); // about six labels on long axes
  c.labels.forEach((lab, i) => {
    // the last label on a long axis ends at its point so it isn't cut off
    if ((n - 1 - i) % every === 0)
      g +=
        '<text x="' +
        x(i) +
        '" y="' +
        (H - 8) +
        '" text-anchor="' +
        (every > 1 && i === n - 1 ? "end" : "middle") +
        '">' +
        lab +
        "</text>";
  });
  if (c.type === "bar") {
    const w = n <= 7 ? 11 : 5;
    c.values.forEach((v, i) => {
      if (v == null) return;
      g +=
        '<line x1="' +
        x(i) +
        '" x2="' +
        x(i) +
        '" y1="' +
        (y(0) - w / 2) +
        '" y2="' +
        Math.min(y(v) + w / 2, y(0) - w / 2) +
        '" stroke="var(--accent)" stroke-width="' +
        w +
        '" stroke-linecap="round"><title>' +
        c.labels[i] +
        ": " +
        v +
        "</title></line>";
      if (n <= 7)
        g +=
          '<text class="val" x="' +
          x(i) +
          '" y="' +
          (y(v) - 8) +
          '" text-anchor="middle">' +
          fmtK(v) +
          "</text>";
    });
  } else {
    const pts = c.values
      .map((v, i) => (v == null ? null : x(i) + "," + y(v)))
      .filter(Boolean); // points without data are skipped
    g +=
      '<polyline fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" points="' +
      pts.join(" ") +
      '"/>';
    if (n <= 12)
      c.values.forEach((v, i) => {
        if (v != null)
          g +=
            '<circle cx="' +
            x(i) +
            '" cy="' +
            y(v) +
            '" r="3" fill="var(--accent)"><title>' +
            c.labels[i] +
            ": " +
            v +
            "</title></circle>";
      });
  }
  const desc =
    metricLabel +
    ". " +
    c.labels
      .map((l, i) => l + ": " + (c.values[i] == null ? "no data" : c.values[i]))
      .join(", ");
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="' +
    esc(desc) +
    '">' +
    g +
    "</svg>"
  );
}

function statsRow(max, avg, foll, hw) {
  const cell = (k, title, v) =>
    '<div title="' + title + '"><dt>' + k + "</dt><dd>" + v + "</dd></div>";
  return (
    '<dl class="stats">' +
    cell("Max", "Max viewers", num(max)) +
    cell("Avg", "Average viewers", num(avg)) +
    cell("Follows", "Followers gained during the stream", signed(foll)) +
    cell(
      "Watched",
      "Hours watched: average viewers × stream length",
      hours(hw),
    ) +
    "</dl>"
  );
}
function catBar(cat, img) {
  return (
    '<div class="cat-bar">' +
    boxart(cat, img) +
    '<p class="cat-name">' +
    esc(cat) +
    "</p></div>"
  );
}
// Overview: the whole card is a button that opens 30 Days filtered on the category
function catLinkBar(cat, img, i) {
  return (
    '<div class="cat-bar">' +
    boxart(cat, img) +
    '<button class="cat-name cat-link" type="button" data-a="gocat" data-v="' +
    esc(cat) +
    '" data-k="gocat-' +
    i +
    '">' +
    esc(cat) +
    '<span class="sr">: show in 30 Days</span></button></div>'
  );
}
function streamCard(s) {
  return (
    '<article class="card"><div class="card-meta"><p class="title">' +
    fmtDate(s.date) +
    " – " +
    DAYS_LONG[dow(s.date)] +
    '</p><p class="title">' +
    fmtDur(s.dur) +
    "</p></div>" +
    catBar(s.cat, s.catImg) +
    statsRow(s.max, s.avg, s.foll, s.hw) +
    "</article>"
  );
}

// A row of slides that glides sideways. Moved with the chevrons, the dots or a swipe (see moveCarousel).
function carousel(id, slides, names) {
  const last = slides.length - 1,
    idx = (S[id] = Math.min(S[id], last));
  return (
    '<div class="carousel" data-car="' +
    id +
    '"><div class="car-view"><div class="car-track" style="transform:translateX(-' +
    idx * 100 +
    '%)">' +
    slides
      .map(
        (html, i) =>
          '<div class="car-slide"' +
          (i === idx ? "" : ' aria-hidden="true"') +
          ">" +
          html +
          "</div>",
      )
      .join("") +
    "</div></div>" +
    '<div class="dots-nav"><button class="chev" data-a="car" data-v="prev" data-k="' +
    id +
    '-prev" aria-label="Previous" aria-disabled="' +
    (idx === 0) +
    '">' +
    ICON.chev(-1) +
    "</button>" +
    names
      .map(
        (n, i) =>
          '<button class="dot" data-a="car" data-v="' +
          i +
          '" data-k="' +
          id +
          "-" +
          i +
          '" aria-pressed="' +
          (i === idx) +
          '" aria-label="Show ' +
          n +
          '"></button>',
      )
      .join("") +
    '<button class="chev" data-a="car" data-v="next" data-k="' +
    id +
    '-next" aria-label="Next" aria-disabled="' +
    (idx === last) +
    '">' +
    ICON.chev(1) +
    "</button></div></div>"
  );
}

function summarySlide(p, title, agg) {
  const cells = METRICS.map((m) => {
    const cur = agg(p.cur.map((s) => s[m.k])),
      prev = agg(p.prev.map((s) => s[m.k]));
    const f = Math.pow(10, m.dec),
      d = cur == null ? 0 : Math.round((cur - (prev || 0)) * f) / f;
    return (
      '<div class="sum-cell"><div class="sum-top"><p class="sum-num">' +
      num(cur, m.dec) +
      "</p>" +
      (cur == null
        ? ""
        : trendIcon(d, Math.abs(prev || 0)) +
          '<p class="sum-delta" title="Compared with ' +
          p.vs +
          '">' +
          (d > 0 ? "+" : d < 0 ? "−" : "±") +
          Math.abs(d) +
          "</p>") +
      '</div><p class="sum-label">' +
      m.label +
      "</p></div>"
    );
  }).join("");
  return "<h2>" + title + '</h2><div class="sum-grid">' + cells + "</div>";
}

// Three figures for the whole period, shown above the summary and not part of its slides
function keyFigures(p) {
  const avgDur = mean(p.cur.map((s) => s.dur));
  const fig = (value, label) => "<div><b>" + value + "</b>" + label + "</div>";
  return (
    '<section class="keyfigs" aria-label="Key figures">' +
    fig(num(median(p.cur.map((s) => s.max))), "Median max viewers") +
    fig(p.cur.length, p.cur.length === 1 ? "Stream" : "Streams") +
    fig(avgDur == null ? "–" : fmtDurShort(avgDur), "Avg. stream time") +
    "</section>"
  );
}

// 30 Days: pick a category. The most streamed categories first; the rest behind "See more".
function categoryFilter() {
  const from = addDays(TODAY, -29),
    counts = new Map(),
    images = new Map();
  for (const s of S.streams) {
    if (!inRange(s, from, TODAY)) continue;
    counts.set(s.cat, (counts.get(s.cat) || 0) + 1);
    if (s.catImg && !images.has(s.cat)) images.set(s.cat, s.catImg);
  }
  if (!counts.size) return "";
  const cats = [...counts.keys()].sort(
    (a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b),
  );
  const shown = S.catsOpen ? cats : cats.slice(0, CATS_SHOWN);
  if (S.cat !== "all" && cats.includes(S.cat) && !shown.includes(S.cat))
    shown.push(S.cat); // keep the chosen one visible
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const row = (value, key, name, box, count) =>
    '<button class="cat-opt" data-a="cat" data-v="' +
    esc(value) +
    '" data-k="cat-' +
    key +
    '" aria-pressed="' +
    (S.cat === value) +
    '">' +
    box +
    '<span class="cat-name">' +
    esc(name) +
    '</span><span class="cat-count">' +
    count +
    (count === 1 ? " stream" : " streams") +
    "</span></button>";
  return (
    '<section class="cat-section"><h2>Categories</h2><div class="cat-list" role="group" aria-label="Filter by category">' +
    row(
      "all",
      "all",
      "All categories",
      '<span class="boxart" aria-hidden="true">All</span>',
      total,
    ) +
    shown
      .map((c) =>
        row(c, cats.indexOf(c), c, boxart(c, images.get(c)), counts.get(c)),
      )
      .join("") +
    "</div>" +
    (cats.length > CATS_SHOWN
      ? '<button class="more" data-a="catMore" data-k="cat-more" aria-expanded="' +
        S.catsOpen +
        '">' +
        (S.catsOpen
          ? "See less"
          : "See more (" + (cats.length - CATS_SHOWN) + ")") +
        "</button>"
      : "") +
    "</section>"
  );
}

function summary(p) {
  return (
    '<section class="section">' +
    carousel(
      "sum",
      [
        summarySlide(p, "Summary Average", mean),
        summarySlide(p, "Summary Highest", highest),
      ],
      ["summary average", "summary highest"],
    ) +
    "</section>"
  );
}

function chartHead(caption, label) {
  return (
    '<div class="chart-head"><p>' +
    caption +
    "</p><p><b>" +
    label +
    "</b></p></div>"
  );
}

// Latest stream: viewers (line) and new followers per 5 minutes (bars) on one time axis.
// Hover, tap or use the arrow keys on the chart to read each measurement.
const BLOCK_MS = 5 * 60 * 1000;
let TL = null; // the timeline on screen, used by the hover and keyboard handlers

function timelineData(tl) {
  const times = tl.map((m) => new Date(m.at).getTime());
  const t0 = times[0],
    t1 = Math.max(times[times.length - 1], t0 + BLOCK_MS);
  // Followers gained in each 5-minute block: the last count in the block minus the last count before it
  const blocks = Math.ceil((t1 - t0) / BLOCK_MS) || 1,
    lastIn = new Array(blocks).fill(null);
  tl.forEach((m, i) => {
    if (m.followers != null)
      lastIn[Math.min(blocks - 1, Math.floor((times[i] - t0) / BLOCK_MS))] =
        m.followers;
  });
  let before = (tl.find((m) => m.followers != null) || {}).followers ?? null;
  const gained = lastIn.map((f) => {
    if (f == null || before == null) return null;
    const g = f - before;
    before = f;
    return g;
  });
  return { raw: tl, times, t0, t1, viewers: tl.map((m) => m.viewers), gained };
}

function timelineSvg(d) {
  const show = S.tlShow,
    both = show.viewers && show.followers;
  const W = 340,
    H = 226,
    L = 36,
    R = both ? 28 : 10,
    T = 24,
    B = 30,
    plotW = W - L - R,
    plotH = H - T - B; // room on the right for the follower scale
  const xOf = (t) => L + ((t - d.t0) / (d.t1 - d.t0)) * plotW;
  const maxV = Math.max(1, ...d.viewers),
    maxG = Math.max(1, ...d.gained.map((g) => g || 0));
  // The left axis shows viewers. With only followers ticked it shows followers instead.
  const axisMax = show.viewers ? maxV : maxG,
    step = niceStep(axisMax / 4),
    top = step * Math.max(4, Math.ceil(axisMax / step));
  const y = (v) => T + plotH * (1 - Math.max(0, v) / top);
  let g = "";
  for (let v = 0; v <= top; v += step)
    g +=
      '<line class="grid" x1="' +
      L +
      '" x2="' +
      (W - R) +
      '" y1="' +
      y(v) +
      '" y2="' +
      y(v) +
      '"/><text x="' +
      (L - 8) +
      '" y="' +
      (y(v) + 4.5) +
      '" text-anchor="end">' +
      fmtK(v) +
      "</text>";
  // Only start, middle and end times on the time axis
  [
    [d.t0, "start"],
    [(d.t0 + d.t1) / 2, "middle"],
    [d.t1, "end"],
  ].forEach(([t, anchor]) => {
    g +=
      '<text x="' +
      xOf(t) +
      '" y="' +
      (H - 8) +
      '" text-anchor="' +
      anchor +
      '">' +
      hhmm(new Date(t)) +
      "</text>";
  });
  if (show.followers) {
    // Bars share the space with the viewer line, so they use their own scale and carry their number
    const barTop = show.viewers ? T + plotH * 0.55 : T,
      scale = (v) => (v / (show.viewers ? maxG : top)) * (y(0) - barTop);
    if (both) {
      // the bars' own scale on the right, so they aren't read against the viewers axis
      [0, maxG].forEach((v) => {
        g +=
          '<text class="tl-axis2" x="' +
          (W - R + 6) +
          '" y="' +
          (y(0) - scale(v) + 4.5) +
          '">' +
          fmtK(v) +
          "</text>";
      });
      g +=
        '<line class="tl-axis2-line" x1="' +
        (W - R + 2) +
        '" x2="' +
        (W - R + 2) +
        '" y1="' +
        barTop +
        '" y2="' +
        y(0) +
        '"/>';
    }
    const blockW = (BLOCK_MS / (d.t1 - d.t0)) * plotW,
      w = Math.max(4, Math.min(16, blockW * 0.6));
    d.gained.forEach((v, b) => {
      if (!v || v < 0) return;
      const cx = Math.min(W - R - w / 2, xOf(d.t0 + (b + 0.5) * BLOCK_MS)),
        h = scale(v);
      g +=
        '<rect class="tl-bar" x="' +
        (cx - w / 2) +
        '" y="' +
        (y(0) - h) +
        '" width="' +
        w +
        '" height="' +
        h +
        '"/>' +
        '<text class="tl-bar-val" x="' +
        cx +
        '" y="' +
        (y(0) - h - 4) +
        '" text-anchor="middle">' +
        fmtK(v) +
        "</text>";
    });
  }
  if (show.viewers) {
    g +=
      '<polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" points="' +
      d.times.map((t, i) => xOf(t) + "," + y(d.viewers[i])).join(" ") +
      '"/>';
  }
  g +=
    '<g class="tl-cursor" visibility="hidden"><line y1="' +
    T +
    '" y2="' +
    y(0) +
    '"/>' +
    (show.viewers ? '<circle r="4.5"/>' : "") +
    "</g>";
  TL = {
    W,
    xs: d.times.map(xOf),
    idx: d.times.length - 1,
    dotY: show.viewers ? (i) => y(d.viewers[i]) : null,
    lines: (i) => {
      const block = Math.min(
          d.gained.length - 1,
          Math.floor((d.times[i] - d.t0) / BLOCK_MS),
        ),
        gain = d.gained[block];
      const m = d.raw[i],
        out = [hhmm(new Date(d.times[i]))];
      if (m.category) out.push({ cat: m.category, img: m.categoryImage });
      out.push("Viewers: " + d.viewers[i]);
      if (show.followers)
        out.push(
          "New followers (5 min): " + (gain == null ? "–" : signed(gain)),
        );
      if (S.user && S.user.live)
        out.push("Viewers now: " + S.user.live.viewers);
      return out;
    },
  };
  // Text version of the chart for screen readers
  const peak = d.viewers.indexOf(maxV),
    total = d.gained.reduce((a, v) => a + (v || 0), 0);
  const desc =
    "Stream from " +
    hhmm(new Date(d.t0)) +
    " to " +
    hhmm(new Date(d.times[d.times.length - 1])) +
    (show.viewers
      ? ". Peak of " + maxV + " viewers at " + hhmm(new Date(d.times[peak]))
      : "") +
    (show.followers ? ". " + total + " new followers" : "") +
    ".";
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="' +
    esc(desc) +
    '">' +
    g +
    "</svg>"
  );
}

function timelineBlock(p) {
  if (!p.latest) return "";
  const tl = S.timelines[p.latest.id];
  if (!tl)
    return '<section class="chart"><p class="note" role="status">Loading the stream timeline…</p></section>';
  if (!tl.length)
    return '<section class="chart"><p class="note">No measurements saved for this stream.</p></section>';
  const box = (key, label, mark) =>
    '<label><input type="checkbox" data-a="tl" data-v="' +
    key +
    '" data-k="tl-' +
    key +
    '"' +
    (S.tlShow[key] ? " checked" : "") +
    '><span class="key ' +
    mark +
    '" aria-hidden="true"></span>' +
    label +
    "</label>";
  const toggles =
    '<fieldset class="tl-toggles"><legend class="sr">Show in the chart</legend>' +
    box("viewers", "Viewers", "line") +
    box("followers", "Followers", "bar") +
    "</fieldset>";
  const any = S.tlShow.viewers || S.tlShow.followers;
  return (
    '<section class="chart">' +
    chartHead(p.caption, "During Stream") +
    toggles +
    (any
      ? '<div class="tl" tabindex="0" data-k="tl" aria-describedby="tlHelp">' +
        timelineSvg(timelineData(tl)) +
        '<div class="tl-tip" hidden></div></div>' +
        '<p class="sr" id="tlHelp">Use the left and right arrow keys to read each measurement.</p><p class="sr" id="tlLive" aria-live="polite"></p>'
      : '<p class="note">Tick Viewers or Followers to see the chart.</p>') +
    "</section>"
  );
}

// Hover, tap and arrow keys work the same on every interactive chart (.tl). The chart that is drawn sets TL:
// xs = the x position of each point, lines(i) = the text for point i, dotY(i) = where to draw the dot (optional),
// band = width of the highlighted column (bar charts).
function tlShowAt(wrap, i, announce) {
  if (!TL) return;
  const n = TL.xs.length;
  i = Math.max(0, Math.min(n - 1, i));
  TL.idx = i;
  const x = TL.xs[i],
    cursor = wrap.querySelector(".tl-cursor");
  cursor.setAttribute("visibility", "visible");
  const line = cursor.querySelector("line");
  if (line) {
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
  }
  const band = cursor.querySelector("rect");
  if (band) band.setAttribute("x", x - TL.band / 2);
  const dot = cursor.querySelector("circle");
  if (dot && TL.dotY) {
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", TL.dotY(i));
  }
  const lines = TL.lines(i);
  const tip = wrap.querySelector(".tl-tip");
  tip.textContent = "";
  lines.forEach((t, k) => {
    if (typeof t === "string") {
      const el = document.createElement(k ? "p" : "b");
      el.textContent = t;
      tip.appendChild(el);
      return;
    }
    // { cat, img }: category row. Built with DOM methods, so text from Twitch can't become HTML.
    const row = document.createElement("p"),
      art = document.createElement("span");
    row.className = "tip-cat";
    art.className = "tip-art";
    art.setAttribute("aria-hidden", "true");
    art.textContent = initials(t.cat);
    if (
      typeof t.img === "string" &&
      t.img.startsWith("https://static-cdn.jtvnw.net/")
    ) {
      const im = document.createElement("img");
      im.src = t.img;
      im.alt = "";
      art.appendChild(im);
    }
    row.append(art, document.createTextNode(t.cat));
    tip.appendChild(row);
  });
  tip.hidden = false;
  const svgBox = wrap.querySelector("svg").getBoundingClientRect(),
    wrapBox = wrap.getBoundingClientRect();
  // The box sits beside the guide line so it doesn't cover the point. On narrow screens, where it doesn't fit
  // beside the line, it sits just above the chart instead (also out of the way of a finger on a touch screen).
  const px = svgBox.left - wrapBox.left + (x / TL.W) * svgBox.width,
    gap = 12,
    tw = tip.offsetWidth,
    th = tip.offsetHeight;
  let left = px < wrapBox.width / 2 ? px + gap : px - gap - tw,
    top = 8;
  if (left < 0 || left + tw > wrapBox.width) {
    left = Math.max(0, Math.min(wrapBox.width - tw, px - tw / 2));
    top = -th - 4;
  }
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  if (announce)
    $("#tlLive").textContent = lines
      .map((t) => (typeof t === "string" ? t : "Category: " + t.cat))
      .join(", ");
}
function tlHide(wrap) {
  const tip = wrap.querySelector(".tl-tip"),
    cursor = wrap.querySelector(".tl-cursor");
  if (tip) tip.hidden = true;
  if (cursor) cursor.setAttribute("visibility", "hidden");
}
function tlFromPointer(wrap, clientX) {
  const box = wrap.querySelector("svg").getBoundingClientRect(),
    x = ((clientX - box.left) / box.width) * TL.W;
  let best = 0;
  TL.xs.forEach((p, i) => {
    if (Math.abs(p - x) < Math.abs(TL.xs[best] - x)) best = i;
  });
  tlShowAt(wrap, best, false);
}
for (const type of ["pointermove", "pointerdown"]) {
  document.addEventListener(type, (ev) => {
    const wrap = ev.target.closest && ev.target.closest(".tl");
    if (wrap && TL) tlFromPointer(wrap, ev.clientX);
  });
}
document.addEventListener(
  "pointerleave",
  (ev) => {
    if (
      ev.target.classList &&
      ev.target.classList.contains("tl") &&
      document.activeElement !== ev.target
    )
      tlHide(ev.target);
  },
  true,
);
document.addEventListener("focusin", (ev) => {
  if (ev.target.classList && ev.target.classList.contains("tl"))
    tlShowAt(ev.target, TL ? TL.idx : 0, true);
});
document.addEventListener("focusout", (ev) => {
  if (ev.target.classList && ev.target.classList.contains("tl"))
    tlHide(ev.target);
});
document.addEventListener("keydown", (ev) => {
  const wrap =
    ev.target.classList && ev.target.classList.contains("tl")
      ? ev.target
      : null;
  if (!wrap || !TL) return;
  const n = TL.xs.length,
    i = TL.idx;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[
    ev.key
  ];
  if (next === undefined) return;
  ev.preventDefault();
  tlShowAt(wrap, next, true);
});
async function loadTimeline(login, id) {
  if (S.timelines[id] || S.timelineLoading[id]) return;
  S.timelineLoading[id] = true;
  try {
    S.timelines[id] = await DataSource.getTimeline(login, id);
  } catch (e) {
    S.timelines[id] = [];
  }
  delete S.timelineLoading[id];
  if (S.user && S.user.login === login) render();
}

// 30 Days and Weekly: one chart, a checkbox per figure, bars side by side in a colour per figure
function figureValue(m, v) {
  return v == null
    ? "–"
    : m.k === "foll"
      ? signed(v)
      : m.k === "hw"
        ? num(v, 1) + " h"
        : num(v);
}

function barsSvg(p, shown) {
  const W = 340,
    H = 226,
    L = 36,
    R = 10,
    T = 24,
    B = 30,
    plotW = W - L - R,
    plotH = H - T - B;
  const series = shown.map((m) => ({
    m,
    cls: "s" + (METRICS.indexOf(m) + 1),
    values: p.chart(m).values,
  }));
  const labels = p.chart(METRICS[0]).labels,
    n = labels.length;
  const peak = Math.max(
    1,
    ...series.flatMap((s) => s.values.map((v) => v || 0)),
  );
  const step = niceStep(peak / 4),
    top = step * Math.max(4, Math.ceil(peak / step));
  const y = (v) => T + plotH * (1 - Math.max(0, v) / top);
  const slot = plotW / n,
    x = (i) => L + slot * (i + 0.5);
  const groupW = Math.min(slot * 0.8, 14 * series.length),
    bw = groupW / series.length;
  let g = "";
  for (let v = 0; v <= top; v += step)
    g +=
      '<line class="grid" x1="' +
      L +
      '" x2="' +
      (W - R) +
      '" y1="' +
      y(v) +
      '" y2="' +
      y(v) +
      '"/><text x="' +
      (L - 8) +
      '" y="' +
      (y(v) + 4.5) +
      '" text-anchor="end">' +
      fmtK(v) +
      "</text>";
  const every = n <= 12 ? 1 : Math.ceil(n / 6);
  labels.forEach((lab, i) => {
    if ((n - 1 - i) % every === 0)
      g +=
        '<text x="' +
        x(i) +
        '" y="' +
        (H - 8) +
        '" text-anchor="middle">' +
        lab +
        "</text>";
  });
  g +=
    '<g class="tl-cursor" visibility="hidden"><rect class="tl-band" x="0" y="' +
    T +
    '" width="' +
    slot +
    '" height="' +
    plotH +
    '"/></g>';
  labels.forEach((_, i) => {
    series.forEach((s, j) => {
      const v = s.values[i];
      if (v == null || v <= 0) return;
      const bx = x(i) - groupW / 2 + j * bw,
        h = y(0) - y(v);
      g +=
        '<rect class="bar ' +
        s.cls +
        '" x="' +
        bx +
        '" y="' +
        y(v) +
        '" width="' +
        Math.max(1, bw - (series.length > 1 ? 1 : 0)) +
        '" height="' +
        h +
        '"/>';
      if (series.length === 1 && n <= 7)
        g +=
          '<text class="tl-bar-val" x="' +
          (bx + bw / 2) +
          '" y="' +
          (y(v) - 6) +
          '" text-anchor="middle">' +
          fmtK(+num(v, s.m.dec)) +
          "</text>";
    });
  });
  const withData = labels
    .map((_, i) => series.some((s) => s.values[i] != null))
    .lastIndexOf(true);
  TL = {
    W,
    xs: labels.map((_, i) => x(i)),
    band: slot,
    dotY: null,
    idx: withData < 0 ? n - 1 : withData,
    lines: (i) => {
      const d = p.dates[i],
        title = DAYS[dow(d)] + " " + d.getDate() + " " + shortMonth(d);
      if (!series.some((s) => s.values[i] != null)) return [title, "–"];
      // The day's categories (with picture) first, then each ticked figure
      const cats = [];
      p.cur.forEach((st) => {
        if (
          st.date.getTime() === d.getTime() &&
          !cats.some((c) => c.cat === st.cat)
        )
          cats.push({ cat: st.cat, img: st.catImg });
      });
      return [title].concat(
        cats,
        series.map((s) => s.m.label + ": " + figureValue(s.m, s.values[i])),
      );
    },
  };
  const desc =
    "Bar chart of " +
    shown.map((m) => m.label).join(", ") +
    ", " +
    p.caption +
    ".";
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="' +
    esc(desc) +
    '">' +
    g +
    "</svg>"
  );
}

function figuresChart(p) {
  const shown = METRICS.filter((m) => S.chartShow[m.k]);
  const boxes = METRICS.map(
    (m, i) =>
      '<label><input type="checkbox" data-a="series" data-v="' +
      m.k +
      '" data-k="series-' +
      m.k +
      '"' +
      (S.chartShow[m.k] ? " checked" : "") +
      '><span class="key bar s' +
      (i + 1) +
      '" aria-hidden="true"></span>' +
      m.label +
      "</label>",
  ).join("");
  return (
    '<section class="chart">' +
    chartHead(p.caption, shown.length === 1 ? shown[0].label : "Per Day") +
    '<fieldset class="tl-toggles"><legend class="sr">Show in the chart</legend>' +
    boxes +
    "</fieldset>" +
    (shown.length
      ? '<div class="tl" tabindex="0" data-k="tl" aria-describedby="tlHelp">' +
        barsSvg(p, shown) +
        '<div class="tl-tip" hidden></div></div>' +
        '<p class="sr" id="tlHelp">Use the left and right arrow keys to read each day.</p><p class="sr" id="tlLive" aria-live="polite"></p>'
      : '<p class="note">Tick at least one figure to see the chart.</p>') +
    "</section>"
  );
}

function chartBlock(p) {
  if (p.mode === "latest") return timelineBlock(p);
  if (S.tab === "30" || S.tab === "weekly") return figuresChart(p);
  const slides = METRICS.map(
    (m) =>
      '<div class="chart-head"><p>' +
      p.caption +
      "</p><p><b>" +
      m.label +
      "</b></p></div>" +
      chartSvg(p.chart(m), m.label),
  );
  return (
    '<section class="chart">' +
    carousel(
      "metric",
      slides,
      METRICS.map((m) => "chart of " + m.label),
    ) +
    "</section>"
  );
}

function actions(p) {
  return (
    '<div class="actions">' +
    '<div><button class="action" data-a="fetch" data-k="fetch"' +
    (S.busy ? " disabled" : "") +
    ">" +
    (S.busy ? "Fetching from Twitch…" : "Fetch new data") +
    ICON.refresh +
    "</button>" +
    '<p class="note">Last fetched ' +
    fmtWhen(S.user.lastFetched) +
    ". " +
    (S.user.saved
      ? "Saved users are also fetched once a day."
      : "Save this user to fetch them automatically once a day.") +
    "</p></div>" +
    '<a class="action" href="https://www.twitch.tv/' +
    encodeURIComponent(S.user.login) +
    '" target="_blank" rel="noopener">Go to twitch page' +
    ICON.go +
    "</a>" +
    '<div><button class="action" data-a="exportToggle" data-k="export" aria-expanded="' +
    S.exportOpen +
    '">Export CSV file' +
    ICON.down(S.exportOpen) +
    "</button>" +
    (S.exportOpen
      ? '<div class="export-menu"><button data-a="export" data-v="sheets" data-k="exp-sheets">For Google Sheets<small>Comma separated</small></button><button data-a="export" data-v="excel" data-k="exp-excel">For Excel<small>Semicolon separated, opens correctly in Swedish Excel</small></button></div><p class="note">Exports the ' +
        exportRows(p).length +
        " streams on this tab.</p>"
      : "") +
    "</div></div>"
  );
}

function renderOverview() {
  const u = S.user,
    from = addDays(TODAY, -29);
  const status =
    u.status === "partner"
      ? "Partner"
      : u.status === "affiliate"
        ? "Affiliated"
        : "Not affiliated";
  const recent = S.streams.filter(
      (s) => inRange(s, from, TODAY) && s.cat !== NO_CATEGORY,
    ),
    groups = {};
  recent.forEach((s) => (groups[s.cat] = groups[s.cat] || []).push(s));
  const top = Object.entries(groups)
    .sort(
      (a, b) =>
        b[1].reduce((t, s) => t + s.dur, 0) -
        a[1].reduce((t, s) => t + s.dur, 0),
    )
    .slice(0, 3);
  const cards = top
    .map(
      ([cat, list], i) =>
        '<article class="card linked"><div class="card-meta"><p class="title only-right">Avg Time: ' +
        fmtDur(mean(list.map((s) => s.dur))) +
        "</p></div>" +
        catLinkBar(cat, list[0].catImg, i) +
        statsRow(
          highest(list.map((s) => s.max)),
          mean(list.map((s) => s.avg)),
          sum(list.map((s) => s.foll)),
          sum(list.map((s) => s.hw)),
        ) +
        "</article>",
    )
    .join("");
  return (
    '<div class="facts"><p>Status: ' +
    status +
    "</p><p>Followers: " +
    (u.followers == null ? "–" : u.followers.toLocaleString("en-US")) +
    "</p></div>" +
    (u.live
      ? '<p class="live">Live now with ' +
        u.live.viewers +
        " viewers" +
        (u.live.category ? " in " + esc(u.live.category) : "") +
        "</p>"
      : "") +
    '<p class="bio">' +
    esc(u.bio) +
    "</p><hr>" +
    '<h2 class="center">Top ' +
    (top.length || 3) +
    " Category Last 30 Days</h2>" +
    (cards ||
      '<p class="empty">No streams with a known category in the last 30 days. Categories and viewer numbers are saved while the server measures a live stream.</p>') +
    "<hr>"
  );
}

function renderStats(p) {
  return (
    (S.tab === "30" ? categoryFilter() : "") +
    keyFigures(p) +
    summary(p) +
    chartBlock(p) +
    '<hr><h2 class="center">' +
    p.listTitle +
    "</h2>" +
    (p.cur.length
      ? p.cur.map(streamCard).join("")
      : '<p class="empty">' + p.empty + "</p>") +
    "<hr>"
  );
}

function subTabs() {
  if (S.tab === "weekly") {
    const monday = addDays(TODAY, -dow(TODAY) + S.weekOff * 7);
    return (
      '<div class="stepper"><button data-a="week" data-v="-1" data-k="wk-prev" aria-label="Previous week"' +
      (S.weekOff <= -12 ? " disabled" : "") +
      ">" +
      ICON.chev(-1) +
      "</button><p>Week " +
      fmtSpan(monday, addDays(monday, 6)) +
      '</p><button data-a="week" data-v="1" data-k="wk-next" aria-label="Next week"' +
      (S.weekOff >= 0 ? " disabled" : "") +
      ">" +
      ICON.chev(1) +
      "</button></div>"
    );
  }
  if (S.tab === "day") {
    const days = streamedDays();
    if (!days.length) return "";
    const plural = DAYS_LONG[S.day].toLowerCase() + "s",
      names = days.length <= 3 ? DAYS_LONG : DAYS; // full names when there is room
    return (
      '<div class="tabs">' +
      days
        .map(
          (i) =>
            '<button class="tab" data-a="day" data-v="' +
            i +
            '" data-k="day-' +
            i +
            '" aria-pressed="' +
            (i === S.day) +
            '" aria-label="' +
            DAYS_LONG[i] +
            '">' +
            names[i] +
            "</button>",
        )
        .join("") +
      "</div>" +
      '<div class="tabs wrap">' +
      [
        ["latest", "Latest stream"],
        [4, "Past 4 " + plural],
        [12, "Past 12 " + plural],
      ]
        .map(
          ([n, label]) =>
            '<button class="tab" data-a="range" data-v="' +
            n +
            '" data-k="range-' +
            n +
            '" aria-pressed="' +
            (n === S.range) +
            '">' +
            label +
            "</button>",
        )
        .join("") +
      "</div>"
    );
  }
  return "";
}

function searchForm() {
  const back =
    S.view === "user"
      ? '<button class="back-btn" type="button" data-a="home" data-k="back" aria-label="Back to start" title="Back to start">' +
        ICON.chev(-1) +
        "</button>"
      : "";
  return (
    '<div class="search-row">' +
    back +
    '<form class="search" id="searchForm" role="search">' +
    ICON.search +
    '<input id="q" type="search" placeholder="Search Twitch user" aria-label="Search Twitch user" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search"></form></div>' +
    (S.error
      ? '<p class="field-error" role="alert">' + esc(S.error) + "</p>"
      : "") +
    (S.loading
      ? '<p class="note" role="status">' + esc(S.loading) + "</p>"
      : "")
  );
}

// The colour picker is a small dialogue. Every colour is its own Tab stop, Enter or Space picks it,
// the arrow keys also move between the items, Tab stays inside the picker and Escape closes it.
function pickerHtml() {
  const idx = ACCENTS.indexOf(S.accent);
  return (
    '<div class="picker" id="picker" role="dialog" aria-modal="true" aria-label="Accent colour">' +
    ACCENTS.map(
      (c, i) =>
        '<button class="swatch" type="button" style="background-color:' +
        c +
        '" data-a="accent" data-v="' +
        c +
        '" data-k="sw-' +
        i +
        '"' +
        ' aria-pressed="' +
        (i === idx) +
        '" aria-label="' +
        ACCENT_NAMES[i] +
        '"></button>',
    ).join("") +
    '<label class="swatch custom" data-on="' +
    (idx < 0) +
    '"><span class="sr">Pick your own colour</span><input type="color" id="customColor" data-k="sw-custom" value="' +
    S.accent +
    '"></label>' +
    '<button class="picker-close" type="button" data-a="closePicker" data-k="picker-close" aria-label="Close colour picker">' +
    ICON.close +
    "</button></div>"
  );
}
function openPicker() {
  const idx = ACCENTS.indexOf(S.accent);
  S.pickerOpen = true;
  S.focus = idx < 0 ? "sw-custom" : "sw-" + idx;
  render();
}
function closePicker() {
  S.pickerOpen = false;
  S.focus = "palette";
  render();
}

function savedList() {
  if (!S.saved.length)
    return '<p class="empty">No saved users yet. Search for a streamer, then tap the bookmark to keep them here and fetch their data every day.</p>';
  const rows = S.saved
    .slice(0, S.savedShown)
    .map(
      (u) =>
        '<div class="user-row"><button class="user-open" data-a="open" data-v="' +
        esc(u.login) +
        '" data-k="open-' +
        esc(u.login) +
        '">' +
        avatar(u) +
        '<span class="uname">' +
        esc(u.displayName) +
        "</span></button>" +
        '<button class="bookmark on" data-a="unsave" data-v="' +
        esc(u.login) +
        '" aria-label="Remove ' +
        esc(u.login) +
        ' from saved users">' +
        ICON.bookmark(true) +
        "</button></div>",
    )
    .join("");
  const left = S.saved.length - S.savedShown;
  return (
    '<div class="saved-list">' +
    rows +
    "</div>" +
    (left > 0
      ? '<button class="more" data-a="loadMore" data-k="load-more" aria-label="Load ' +
        Math.min(left, SAVED_PAGE) +
        ' more saved users">Load more</button>'
      : "")
  );
}

function render() {
  const active =
    document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.k
      : null;
  const keep = S.focus || active;
  S.focus = null;
  document.body.classList.toggle("is-start", S.view === "start");

  const toLight = S.theme === "dark";
  $("#heroTools").innerHTML =
    '<button class="theme-btn" type="button" data-a="theme" data-k="theme" aria-label="' +
    (toLight ? "Switch to light mode" : "Switch to dark mode") +
    '">' +
    (toLight ? ICON.sun : ICON.moon) +
    "</button>" +
    (S.pickerOpen
      ? pickerHtml()
      : '<button class="palette-btn" type="button" data-a="palette" data-k="palette" aria-haspopup="dialog" aria-label="Change accent colour">' +
        ICON.palette +
        "</button>");

  let html = searchForm();
  if (S.view === "start") {
    html += '<h2 class="label">Saved users</h2>' + savedList();
  } else {
    const u = S.user,
      p = S.tab === "overview" ? null : period();
    const tabs = [
      ["overview", "Overview"],
      ["30", "30 Days"],
      ["weekly", "Weekly"],
      ["day", "Day"],
    ];
    html +=
      '<div class="usercard"><div class="user-row"><div class="user-open">' +
      avatar(u) +
      '<p class="uname">' +
      esc(u.displayName) +
      "</p></div>" +
      '<button class="bookmark ' +
      (u.saved ? "on" : "") +
      '" data-a="toggleSave" data-k="save" aria-pressed="' +
      u.saved +
      '" aria-label="' +
      (u.saved ? "Remove from saved users" : "Save user") +
      '">' +
      ICON.bookmark(u.saved) +
      "</button></div>" +
      '<nav class="tabs" aria-label="Statistics pages">' +
      tabs
        .map(
          ([id, name]) =>
            '<button class="tab" data-a="tab" data-v="' +
            id +
            '" data-k="tab-' +
            id +
            '"' +
            (S.tab === id ? ' aria-current="page"' : "") +
            ">" +
            name +
            "</button>",
        )
        .join("") +
      "</nav>" +
      subTabs() +
      "</div>" +
      (p ? renderStats(p) : renderOverview()) +
      actions(p);
  }
  $("#app").innerHTML = html;
  if (S.view === "user" && S.tab === "day" && S.range === "latest") {
    const latest = S.streams.find((x) => dow(x.date) === S.day);
    if (latest) loadTimeline(S.user.login, latest.id);
  }
  // While the colour picker is open, the rest of the page can't be reached with the keyboard or a screen reader
  for (const el of [$("main"), $("footer"), $(".logo"), $(".theme-btn")])
    el.inert = S.pickerOpen;
  if (keep) {
    const el = document.querySelector('[data-k="' + keep + '"]');
    if (el) el.focus({ preventScroll: true });
  }
}

/* =====================================================================
   6. ACTIONS
   ===================================================================== */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.textContent = ""), 5000);
}

async function loadSaved() {
  try {
    S.saved = await DataSource.getSaved();
  } catch (e) {
    S.error = e.message;
  }
  render();
}

/* ---- Browser history: back/forward buttons and swipe gestures go to where you were ----
   Opening a user, going to start and switching page tab add a history step.
   Filters (weekday, range, week, category) update the current step, so the address always
   matches what you see and a reload or the forward button brings them back. */
const TABS = ["overview", "30", "weekly", "day"];
function navState() {
  if (S.view !== "user" || !S.user) return { view: "start" };
  return {
    view: "user",
    login: S.user.login,
    tab: S.tab,
    day: S.day,
    range: S.range,
    weekOff: S.weekOff,
    cat: S.cat,
  };
}
function urlFor(st) {
  if (st.view !== "user") return location.pathname;
  const q = new URLSearchParams({ user: st.login });
  if (st.tab !== "overview") q.set("tab", st.tab);
  if (st.tab === "day") {
    if (st.day != null) q.set("day", DAYS[st.day].toLowerCase());
    q.set("range", String(st.range));
  }
  if (st.tab === "weekly" && st.weekOff) q.set("week", String(st.weekOff));
  if (st.tab === "30" && st.cat !== "all") q.set("category", st.cat);
  return location.pathname + "?" + q;
}
// The address can be typed or edited by anyone, so every value is checked
function stateFromUrl() {
  const q = new URLSearchParams(location.search),
    login = (q.get("user") || "").toLowerCase();
  if (!/^[a-z0-9_]{4,25}$/.test(login)) return { view: "start" };
  const day = DAYS.map((d) => d.toLowerCase()).indexOf(q.get("day"));
  const range =
    q.get("range") === "latest" ? "latest" : q.get("range") === "12" ? 12 : 4;
  const week = parseInt(q.get("week"), 10);
  return {
    view: "user",
    login,
    tab: TABS.includes(q.get("tab")) ? q.get("tab") : "overview",
    day: day < 0 ? null : day,
    range,
    weekOff: Number.isInteger(week) ? Math.max(-12, Math.min(0, week)) : 0,
    cat: (q.get("category") || "all").slice(0, 100),
  };
}
function remember(push) {
  const st = navState();
  if (push) {
    history.replaceState(
      Object.assign({}, history.state, { scroll: window.scrollY }),
      "",
    ); // where to scroll back to
    history.pushState(Object.assign({ scroll: 0 }, st), "", urlFor(st));
  } else {
    history.replaceState(
      Object.assign({}, st, {
        scroll: history.state ? history.state.scroll : 0,
      }),
      "",
      urlFor(st),
    );
  }
}
function applyUserNav(st) {
  Object.assign(S, {
    tab: st.tab || "overview",
    range: st.range || 4,
    weekOff: st.weekOff || 0,
    cat: st.cat || "all",
    exportOpen: false,
    pickerOpen: false,
  });
  S.day =
    st.day != null && streamedDays().includes(st.day) ? st.day : defaultDay();
}
async function goHome(push) {
  Object.assign(S, {
    view: "start",
    error: "",
    exportOpen: false,
    pickerOpen: false,
  });
  if (push) remember(true);
  await loadSaved();
}
// Back/forward: show the step the browser moved to
async function goTo(st) {
  st = st || stateFromUrl();
  if (st.view !== "user") await goHome(false);
  else if (S.user && S.user.login === st.login) {
    S.view = "user";
    applyUserNav(st);
    render();
  } else await openUser(st.login, st, false);
  window.scrollTo(0, st.scroll || 0);
}
window.addEventListener("popstate", (ev) => goTo(ev.state));
if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // we restore the scroll ourselves once the page is drawn

// Search or tap a saved user. A user we have never seen is fetched from Twitch first.
// nav: tab and filters to show (from the address or history). push: add a history step.
async function openUser(raw, nav, push = true) {
  const login = String(raw).trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{4,25}$/.test(login)) {
    S.error =
      "Twitch usernames are 4–25 characters: letters, numbers and underscores.";
    render();
    const q = $("#q");
    if (q) {
      q.value = raw;
      q.focus();
    }
    return;
  }
  S.error = "";
  S.loading = "Loading " + login + "…";
  render();
  try {
    let user;
    try {
      user = await DataSource.getUser(login);
    } catch (e) {
      if (e.status !== 404) throw e;
      user = await DataSource.fetchNow(login);
    }
    const streams = toStreams(await DataSource.getStreams(login));
    if (push)
      history.replaceState(
        Object.assign({}, history.state, { scroll: window.scrollY }),
        "",
      );
    Object.assign(S, {
      view: "user",
      user,
      streams,
      catsOpen: false,
      metric: 0,
      sum: 0,
      timelines: {},
      timelineLoading: {},
    });
    applyUserNav(nav || {});
    if (push) {
      history.pushState(
        Object.assign({ scroll: 0 }, navState()),
        "",
        urlFor(navState()),
      );
      window.scrollTo(0, 0);
    } else remember(false);
  } catch (e) {
    S.error = e.message;
    if (!push) {
      S.view = "start";
      remember(false);
      await loadSaved();
    }
  }
  S.loading = "";
  render();
}

// The "Fetch new data" button
async function fetchNow() {
  if (S.busy) return;
  S.busy = true;
  render();
  const login = S.user.login;
  try {
    const user = await DataSource.fetchNow(login);
    const streams = toStreams(await DataSource.getStreams(login));
    if (S.user && S.user.login === login) {
      S.user = user;
      S.streams = streams;
      if (!streamedDays().includes(S.day)) {
        S.day = defaultDay();
        remember(false);
      }
    }
    toast(
      user.live
        ? "Saved. Live now with " + user.live.viewers + " viewers."
        : "Saved. Not live right now.",
    );
  } catch (e) {
    toast(e.message);
  }
  S.busy = false;
  render();
}

async function setSaved(login, saved) {
  try {
    const user = await DataSource.setSaved(login, saved);
    if (S.user && S.user.login === login) S.user = user;
    S.saved = await DataSource.getSaved();
  } catch (e) {
    toast(e.message);
  }
  render();
}

// Slides a carousel to another slide without redrawing the page, so the CSS transition can run
function moveCarousel(car, to) {
  const id = car.dataset.car,
    slides = car.querySelectorAll(".car-slide");
  const idx = Math.max(0, Math.min(slides.length - 1, to));
  S[id] = idx;
  car.querySelector(".car-track").style.transform =
    "translateX(-" + idx * 100 + "%)";
  slides.forEach((el, i) => {
    if (i === idx) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", "true");
  });
  car
    .querySelectorAll(".dot")
    .forEach((el, i) => el.setAttribute("aria-pressed", i === idx));
  const chevs = car.querySelectorAll(".chev");
  chevs[0].setAttribute("aria-disabled", idx === 0);
  chevs[1].setAttribute("aria-disabled", idx === slides.length - 1);
}

function exportRows(p) {
  if (!p) {
    const from = addDays(TODAY, -29);
    return S.streams.filter((s) => inRange(s, from, TODAY));
  }
  return p.cur;
}

function buildCsv(rows, sep) {
  const head = [
    "date",
    "weekday",
    "start_time",
    "category",
    "duration_minutes",
    "avg_viewers",
    "max_viewers",
    "followers_gained",
    "hours_watched",
  ];
  const q = (v) => {
    if (v == null) return "";
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) v = "'" + v; // text that looks like a formula is kept as plain text
    v = String(v);
    return /[",;\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = rows
    .slice()
    .reverse()
    .map((s) =>
      [
        isoDate(s.date),
        DAYS_LONG[dow(s.date)],
        s.start,
        s.cat,
        s.dur,
        s.avg,
        s.max,
        s.foll,
        s.hw,
      ]
        .map(q)
        .join(sep),
    );
  return [head.join(sep)].concat(lines).join("\r\n") + "\r\n";
}

function exportCsv(kind) {
  const rows = exportRows(S.tab === "overview" ? null : period());
  if (!rows.length) {
    toast("There are no streams on this tab to export.");
    return;
  }
  const excel = kind === "excel";
  const text = (excel ? "\uFEFF" : "") + buildCsv(rows, excel ? ";" : ",");
  const scope =
    S.tab === "day"
      ? DAYS[S.day].toLowerCase() +
        (S.range === "latest" ? "-latest" : "-past" + S.range)
      : S.tab === "30"
        ? "30days"
        : S.tab;
  const filename =
    "oversikt_" + S.user.login + "_" + scope + "_" + isoDate(TODAY) + ".csv";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Exported " + rows.length + " streams to " + filename);
}

document.addEventListener("click", (ev) => {
  if (S.pickerOpen && !ev.target.closest("#picker")) {
    closePicker();
    return;
  } // click outside closes the picker
  const el = ev.target.closest("[data-a]");
  if (!el) return;
  const a = el.dataset.a,
    v = el.dataset.v;
  if (a === "home") {
    ev.preventDefault();
    if (S.view !== "start") goHome(true);
    window.scrollTo(0, 0);
    return;
  }
  if (a === "open") {
    openUser(v);
    return;
  }
  if (a === "fetch") {
    fetchNow();
    return;
  }
  if (a === "unsave") {
    setSaved(v, false);
    return;
  }
  if (a === "toggleSave") {
    setSaved(S.user.login, !S.user.saved);
    return;
  }
  if (a === "export") {
    exportCsv(v);
    return;
  }
  if (a === "car") {
    const car = el.closest(".carousel");
    moveCarousel(
      car,
      v === "prev"
        ? S[car.dataset.car] - 1
        : v === "next"
          ? S[car.dataset.car] + 1
          : +v,
    );
    return;
  }
  if (a === "palette") {
    openPicker();
    return;
  }
  if (a === "closePicker") {
    closePicker();
    return;
  }
  if (a === "theme") {
    S.themeChosen = true;
    setTheme(S.theme === "dark" ? "light" : "dark");
  } else if (a === "accent") setAccent(v);
  else if (a === "tab") {
    if (S.tab !== v) {
      S.tab = v;
      S.exportOpen = false;
      remember(true);
    }
  } else if (a === "day") {
    S.day = +v;
    remember(false);
  } else if (a === "range") {
    S.range = v === "latest" ? "latest" : +v;
    remember(false);
  } else if (a === "week") {
    S.weekOff = Math.max(-12, Math.min(0, S.weekOff + +v));
    remember(false);
  } else if (a === "cat") {
    S.cat = v;
    remember(false);
  } else if (a === "tl") S.tlShow[v] = el.checked;
  else if (a === "series") S.chartShow[v] = el.checked;
  else if (a === "gocat") {
    Object.assign(S, { tab: "30", cat: v, catsOpen: false, exportOpen: false });
    remember(true);
    render();
    window.scrollTo(0, 0);
    return;
  } else if (a === "catMore") S.catsOpen = !S.catsOpen;
  else if (a === "loadMore") {
    const next = S.saved[S.savedShown];
    S.savedShown += SAVED_PAGE;
    if (next) S.focus = "open-" + next.login;
  } else if (a === "exportToggle") S.exportOpen = !S.exportOpen;
  render();
});
// Swipe sideways on a summary or chart
let swipe = null;
document.addEventListener(
  "touchstart",
  (ev) => {
    const view = ev.target.closest(".car-view");
    swipe = view
      ? {
          car: view.parentElement,
          x: ev.touches[0].clientX,
          y: ev.touches[0].clientY,
        }
      : null;
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  (ev) => {
    if (!swipe) return;
    const dx = ev.changedTouches[0].clientX - swipe.x,
      dy = ev.changedTouches[0].clientY - swipe.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5)
      moveCarousel(swipe.car, S[swipe.car.dataset.car] + (dx < 0 ? 1 : -1));
    swipe = null;
  },
  { passive: true },
);

document.addEventListener("keydown", (ev) => {
  if (!S.pickerOpen) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closePicker();
    return;
  }
  const stops = [...$("#picker").querySelectorAll("button, input")];
  const i = stops.indexOf(document.activeElement),
    last = stops.length - 1;
  const step = {
    Tab: ev.shiftKey ? -1 : 1,
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  }[ev.key];
  let next = null;
  if (step)
    next = i < 0 ? 0 : (i + step + stops.length) % stops.length; // Tab and arrows go round inside the picker
  else if (ev.key === "Home") next = 0;
  else if (ev.key === "End") next = last;
  if (next === null) return;
  ev.preventDefault();
  stops[next].focus();
});
if (systemDark)
  systemDark.addEventListener("change", (e) => {
    if (!S.themeChosen) {
      setTheme(e.matches ? "dark" : "light");
      render();
    }
  });

// A picture that can't be loaded is removed, so the letters underneath show instead
document.addEventListener(
  "error",
  (ev) => {
    if (ev.target instanceof HTMLImageElement) ev.target.remove();
  },
  true,
);

document.addEventListener("submit", (ev) => {
  if (ev.target.id === "searchForm") {
    ev.preventDefault();
    openUser($("#q").value);
  }
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "customColor") setAccent(ev.target.value);
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "customColor") render();
});

/* =====================================================================
   7. START
   ===================================================================== */
const savedAccent = load("oversikt.accent", ACCENTS[0]);
setAccent(/^#[0-9a-f]{6}$/i.test(savedAccent) ? savedAccent : ACCENTS[0]);
render();
(function start() {
  const st = stateFromUrl();
  history.replaceState(Object.assign({ scroll: 0 }, st), "", urlFor(st));
  if (st.view === "user") openUser(st.login, st, false);
  else loadSaved();
})();
