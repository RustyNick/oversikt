require("dotenv").config();
const path = require("path");
const express = require("express");
const db = require("./db");
const { fetchUser, startSchedules } = require("./collector");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const LOCAL_ONLY = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const LOCAL_HOSTS = new Set(
  ["localhost", "127.0.0.1", "[::1]"].flatMap((h) => [h, h + ":" + PORT]),
);
const safeImage = (url) =>
  typeof url === "string" && url.startsWith("https://static-cdn.jtvnw.net/")
    ? url
    : null;
const boxArt = (url) =>
  safeImage(
    url ? url.replace("{width}", "104").replace("{height}", "138") : null,
  );

const app = express();
app.disable("x-powered-by");

// ---------------------------------------------------------------------------
// 1. Security for every request
// ---------------------------------------------------------------------------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https://static-cdn.jtvnw.net",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use((req, res, next) => {
  if (LOCAL_ONLY && !LOCAL_HOSTS.has(req.get("host")))
    return res.status(403).type("text").send("Forbidden");
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
});

app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.get("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch (e) {
      /* ogiltig origin */
    }
    if (host !== req.get("host"))
      return res
        .status(403)
        .json({ error: "Requests from other websites are not allowed." });
  }
  next();
});

app.use(express.json({ limit: "1kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.param("login", (req, res, next, value) => {
  const login = String(value).toLowerCase();
  if (!/^[a-z0-9_]{4,25}$/.test(login))
    return res.status(400).json({ error: "Not a valid Twitch username." });
  req.login = login;
  next();
});

// ---------------------------------------------------------------------------
// 2. Database queries (prepared once, parameterised)
// ---------------------------------------------------------------------------
const q = {
  user: db.prepare("SELECT * FROM users WHERE login = ?"),
  followers: db.prepare(
    "SELECT total FROM follower_counts WHERE login = ? ORDER BY day DESC LIMIT 1",
  ),
  lastSnapshot: db.prepare(
    "SELECT viewers, category, at FROM snapshots WHERE login = ? ORDER BY at DESC LIMIT 1",
  ),
  timeline: db.prepare(`
    SELECT s.at, s.viewers, s.followers, s.category, c.box_art_url AS image
    FROM snapshots s LEFT JOIN categories c ON c.name = s.category
    WHERE s.login = ? AND s.stream_id = ? ORDER BY s.at
  `),
  savedUsers: db.prepare(
    "SELECT login, display_name, profile_image_url FROM users WHERE saved = 1 ORDER BY login",
  ),
  setSaved: db.prepare("UPDATE users SET saved = ? WHERE login = ?"),
  streams: db.prepare(`
    SELECT s.stream_id AS id, MIN(s.started_at) AS startedAt, MAX(s.at) AS lastAt,
           COUNT(*) AS checks, MAX(s.viewers) AS maxViewers, AVG(s.viewers) AS avgViewers,
           COUNT(s.followers) AS followerChecks,
           (SELECT f.followers FROM snapshots f WHERE f.login = s.login AND f.stream_id = s.stream_id
              AND f.followers IS NOT NULL ORDER BY f.at ASC LIMIT 1) AS followersFirst,
           (SELECT f.followers FROM snapshots f WHERE f.login = s.login AND f.stream_id = s.stream_id
              AND f.followers IS NOT NULL ORDER BY f.at DESC LIMIT 1) AS followersLast,
           (SELECT v.duration_min FROM vods v WHERE v.login = s.login AND v.stream_id = s.stream_id) AS vodMinutes
    FROM snapshots s
    WHERE s.login = ? AND s.started_at >= ?
    GROUP BY s.stream_id
    ORDER BY startedAt DESC
  `),
  streamCategories: db.prepare(`
    SELECT s.stream_id AS id, s.category, c.box_art_url AS image, COUNT(*) AS n
    FROM snapshots s LEFT JOIN categories c ON c.name = s.category
    WHERE s.login = ? AND s.started_at >= ? AND s.category IS NOT NULL
    GROUP BY s.stream_id, s.category
    ORDER BY n DESC
  `),
};

function userJson(login) {
  const u = q.user.get(login);
  if (!u) return null;
  const followers = q.followers.get(login);
  const last = q.lastSnapshot.get(login);
  const isLive = last && Date.now() - new Date(last.at) < 10 * 60 * 1000;
  return {
    login: u.login,
    displayName: u.display_name || u.login,
    status: u.broadcaster_type || "",
    bio: u.description || "",
    avatar: safeImage(u.profile_image_url),
    followers: followers ? followers.total : null,
    saved: Boolean(u.saved),
    lastFetched: u.last_fetched,
    live: isLive ? { viewers: last.viewers, category: last.category } : null,
  };
}

function streamsJson(login) {
  const since = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  const categories = new Map();
  for (const c of q.streamCategories.all(login, since))
    if (!categories.has(c.id)) categories.set(c.id, c);

  return q.streams.all(login, since).map((st) => {
    const cat = categories.get(st.id);
    const durationMin =
      st.vodMinutes ??
      Math.max(
        1,
        Math.round((new Date(st.lastAt) - new Date(st.startedAt)) / 60000),
      );
    const image = boxArt(cat && cat.image);
    return {
      id: st.id,
      startedAt: st.startedAt,
      durationMin,
      category: cat ? cat.category : null,
      categoryImage: safeImage(image),
      maxViewers: st.maxViewers,
      avgViewers: Math.round(st.avgViewers),

      followersGained:
        st.followerChecks >= 2 ? st.followersLast - st.followersFirst : null,

      hoursWatched: Math.round((st.avgViewers * durationMin) / 6) / 10,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. API
// ---------------------------------------------------------------------------
app.get("/api/users", (req, res) => {
  res.json(
    q.savedUsers
      .all()
      .map((r) => ({
        login: r.login,
        displayName: r.display_name || r.login,
        avatar: safeImage(r.profile_image_url),
      })),
  );
});

app.get("/api/users/:login", (req, res) => {
  const user = userJson(req.login);
  if (!user)
    return res.status(404).json({ error: "No data saved for this user yet." });
  res.json(user);
});

app.get("/api/users/:login/streams", (req, res) =>
  res.json(streamsJson(req.login)),
);

app.get("/api/users/:login/streams/:streamId/timeline", (req, res) => {
  const id = String(req.params.streamId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
    return res.status(400).json({ error: "Not a valid stream id." });
  res.json(
    q.timeline
      .all(req.login, id)
      .map((m) => ({
        at: m.at,
        viewers: m.viewers,
        followers: m.followers,
        category: m.category,
        categoryImage: boxArt(m.image),
      })),
  );
});

const PER_USER_MS = 20 * 1000,
  GLOBAL_PER_MIN = 10;
const lastOnDemand = new Map();
let recentFetches = [];

app.post("/api/users/:login/fetch", async (req, res) => {
  const now = Date.now();
  const wait = PER_USER_MS - (now - (lastOnDemand.get(req.login) || 0));
  if (wait > 0)
    return res
      .status(429)
      .json({
        error:
          "Just fetched. Try again in " + Math.ceil(wait / 1000) + " seconds.",
      });
  recentFetches = recentFetches.filter((t) => now - t < 60 * 1000);
  if (recentFetches.length >= GLOBAL_PER_MIN)
    return res
      .status(429)
      .json({ error: "Too many fetches right now. Try again in a minute." });

  recentFetches.push(now);
  lastOnDemand.set(req.login, now);
  if (lastOnDemand.size > 500)
    for (const [k, t] of lastOnDemand)
      if (now - t > PER_USER_MS) lastOnDemand.delete(k);

  try {
    const found = await fetchUser(req.login);
    if (!found)
      return res
        .status(404)
        .json({ error: "There is no Twitch user called " + req.login + "." });
    res.json(userJson(req.login));
  } catch (err) {
    console.error("[on demand] " + req.login + ": " + err.message);
    res
      .status(err.status || 500)
      .json({
        error: err.status ? err.message : "Could not fetch data from Twitch.",
      });
  }
});

app.put("/api/users/:login/saved", (req, res) => {
  if (!req.body || typeof req.body.saved !== "boolean")
    return res
      .status(400)
      .json({ error: 'Send { "saved": true } or { "saved": false }.' });
  const result = q.setSaved.run(req.body.saved ? 1 : 0, req.login);
  if (!result.changes)
    return res.status(404).json({ error: "No data saved for this user yet." });
  res.json(userJson(req.login));
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res
    .status(status)
    .json({
      error:
        status === 413
          ? "Request too large."
          : status < 500
            ? "Bad request."
            : "Something went wrong on the server.",
    });
});

app.listen(PORT, HOST, () => {
  console.log(
    "Översikt: http://" + (LOCAL_ONLY ? "localhost" : HOST) + ":" + PORT,
  );
  startSchedules();
});
