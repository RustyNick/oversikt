// Fetches data from Twitch and saves it in the database.
// Used by the button in the app, the daily fetch and the optional live check.
const db = require("./db");
const twitch = require("./twitch");

const upsertUser = db.prepare(`
  INSERT INTO users (login, twitch_id, display_name, broadcaster_type, description, profile_image_url, last_fetched)
  VALUES (@login, @twitch_id, @display_name, @broadcaster_type, @description, @profile_image_url, @last_fetched)
  ON CONFLICT(login) DO UPDATE SET
    twitch_id = excluded.twitch_id, display_name = excluded.display_name,
    broadcaster_type = excluded.broadcaster_type, description = excluded.description,
    profile_image_url = excluded.profile_image_url, last_fetched = excluded.last_fetched
`);
const upsertFollowers = db.prepare(`
  INSERT INTO follower_counts (login, day, total) VALUES (?, ?, ?)
  ON CONFLICT(login, day) DO UPDATE SET total = excluded.total
`);
const insertSnapshot = db.prepare(`
  INSERT INTO snapshots (login, stream_id, at, viewers, category, title, started_at, followers)
  VALUES (@login, @stream_id, @at, @viewers, @category, @title, @started_at, @followers)
`);
const upsertVod = db.prepare(`
  INSERT INTO vods (video_id, login, stream_id, created_at, duration_min, view_count, title)
  VALUES (@video_id, @login, @stream_id, @created_at, @duration_min, @view_count, @title)
  ON CONFLICT(video_id) DO UPDATE SET
    duration_min = excluded.duration_min, view_count = excluded.view_count, title = excluded.title
`);

// Twitch writes durations as "3h8m33s"
function durationToMinutes(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text || "");
  if (!m) return 0;
  return Math.round((+m[1] || 0) * 60 + (+m[2] || 0) + (+m[3] || 0) / 60);
}

// followers = the current follower count, used to work out followers gained during the stream
function saveSnapshot(login, stream, followers) {
  insertSnapshot.run({
    login, stream_id: stream.id, at: new Date().toISOString(), viewers: stream.viewer_count,
    category: stream.game_name || null, title: stream.title || null, started_at: stream.started_at,
    followers: Number.isInteger(followers) ? followers : null
  });
}

// Fetches the picture link for categories that aren't in the categories table yet.
// names = the categories just measured. Without names, every measurement is checked (done once at start-up).
const upsertCategory = db.prepare(`
  INSERT INTO categories (name, box_art_url) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET box_art_url = excluded.box_art_url
`);
const knownCategory = db.prepare("SELECT 1 FROM categories WHERE name = ?");
const unknownCategories = db.prepare(`
  SELECT DISTINCT category AS name FROM snapshots
  WHERE category IS NOT NULL AND category NOT IN (SELECT name FROM categories)
`);

async function fetchCategoryImages(names) {
  const missing = names
    ? [...new Set(names.filter(Boolean))].filter((n) => !knownCategory.get(n))
    : unknownCategories.all().map((r) => r.name);
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const found = await twitch.getCategories(chunk);
      for (const name of chunk) {
        const match = found.find((g) => g.name.toLowerCase() === name.toLowerCase());
        upsertCategory.run(name, match ? match.box_art_url : null);
      }
    } catch (err) {
      console.warn("[categories] " + err.message);
    }
  }
}

// Fetches everything about a user. Returns false if the user doesn't exist on Twitch.
async function fetchUser(login) {
  const user = await twitch.getUser(login);
  if (!user) return false;
  const now = new Date().toISOString();

  upsertUser.run({
    login: user.login, twitch_id: user.id, display_name: user.display_name,
    broadcaster_type: user.broadcaster_type || "", description: user.description || "",
    profile_image_url: user.profile_image_url || null, last_fetched: now
  });

  // Followers: skip if Twitch refuses, the rest is still saved
  let total = null;
  try {
    total = await twitch.getFollowerTotal(user.id);
    if (Number.isInteger(total)) upsertFollowers.run(user.login, now.slice(0, 10), total);
  } catch (err) {
    console.warn("[fetch] followers for " + user.login + ": " + err.message);
  }

  // Live right now? Save a measurement.
  const live = await twitch.getLiveStreams([user.id]);
  if (live[0]) saveSnapshot(user.login, live[0], total);

  // Past broadcasts (give the exact length). If this fails, the rest is still saved.
  try {
    const vods = await twitch.getPastBroadcasts(user.id);
    db.exec("BEGIN");
    try {
      for (const v of vods) {
        upsertVod.run({
          video_id: v.id, login: user.login, stream_id: v.stream_id || null, created_at: v.created_at,
          duration_min: durationToMinutes(v.duration), view_count: v.view_count ?? null, title: v.title || null
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.warn("[fetch] past broadcasts for " + user.login + ": " + err.message);
  }

  if (live[0]) await fetchCategoryImages([live[0].game_name]);
  return true;
}

const savedUsersQuery = db.prepare("SELECT login, twitch_id, last_fetched FROM users WHERE saved = 1");
const savedUsers = () => savedUsersQuery.all();

async function fetchAllSaved(reason) {
  const users = savedUsers();
  console.log("[" + reason + "] fetching " + users.length + " saved user(s)");
  for (const u of users) {
    try { await fetchUser(u.login); }
    catch (err) { console.error("[" + reason + "] " + u.login + ": " + err.message); }
  }
}

// Quick check: viewer and follower counts for bookmarked users who are live.
// If a check hasn't finished when the next one is due, the next one is skipped so measurements aren't doubled.
let polling = false;
async function pollLive() {
  if (polling) return;
  polling = true;
  try { await pollLiveOnce(); }
  finally { polling = false; }
}

async function pollLiveOnce() {
  const users = savedUsers(), seen = [];
  for (let i = 0; i < users.length; i += 100) {
    const chunk = users.slice(i, i + 100);
    try {
      const live = await twitch.getLiveStreams(chunk.map((u) => u.twitch_id));
      for (const s of live) {
        let followers = null;
        try { followers = await twitch.getFollowerTotal(s.user_id); }
        catch (err) { console.warn("[live poll] followers for " + s.user_login + ": " + err.message); }
        saveSnapshot(s.user_login, s, followers);
        seen.push(s.game_name);
      }
    } catch (err) {
      console.error("[live poll] " + err.message);
    }
  }
  await fetchCategoryImages(seen);
}

function msUntil(time) {
  const [h, m] = time.split(":").map(Number);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next - new Date();
}

function startSchedules() {
  if (!twitch.hasKeys()) {
    console.warn("No Twitch keys in .env yet: automatic fetching is off.");
    return;
  }
  // 1. Once a day
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(process.env.DAILY_FETCH_TIME || "") ? process.env.DAILY_FETCH_TIME : "20:00";
  const scheduleNext = () => setTimeout(async () => { await fetchAllSaved("daily"); scheduleNext(); }, msUntil(time));
  scheduleNext();
  console.log("Daily fetch at " + time);

  // 2. If the server was off at that time, catch up at start-up
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (savedUsers().some((u) => !u.last_fetched || u.last_fetched < dayAgo)) fetchAllSaved("catch-up");

  // 3. Pictures for categories that don't have one yet
  fetchCategoryImages();

  // 4. Optional live check
  const minutes = Number(process.env.LIVE_POLL_MINUTES) || 0;
  if (minutes > 0) {
    pollLive(); // first measurement straight away at start-up
    setInterval(pollLive, Math.max(1, minutes) * 60 * 1000);
    console.log("Live poll every " + Math.max(1, minutes) + " min");
  }
}

module.exports = { fetchUser, startSchedules };
