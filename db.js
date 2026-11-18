// The database: one SQLite file in the data/ folder. Created automatically the first time.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // built into Node.js, nothing to install

const dir = path.join(__dirname, "data");
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.join(dir, "oversikt.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  -- One row per Twitch user that has been fetched
  CREATE TABLE IF NOT EXISTS users (
    login             TEXT PRIMARY KEY,
    twitch_id         TEXT NOT NULL,
    display_name      TEXT,
    broadcaster_type  TEXT,
    description       TEXT,
    profile_image_url TEXT,
    saved             INTEGER NOT NULL DEFAULT 0,
    last_fetched      TEXT
  );

  -- Follower count, one row per user per day
  CREATE TABLE IF NOT EXISTS follower_counts (
    login TEXT NOT NULL,
    day   TEXT NOT NULL,
    total INTEGER NOT NULL,
    PRIMARY KEY (login, day)
  );

  -- One measurement each time Twitch is asked while the user is live
  CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    login      TEXT NOT NULL,
    stream_id  TEXT NOT NULL,
    at         TEXT NOT NULL,
    viewers    INTEGER NOT NULL,
    category   TEXT,
    title      TEXT,
    started_at TEXT NOT NULL,
    followers  INTEGER
  );
  DROP INDEX IF EXISTS snapshots_login;
  CREATE INDEX IF NOT EXISTS snapshots_login_started ON snapshots (login, started_at);
  CREATE INDEX IF NOT EXISTS snapshots_stream ON snapshots (login, stream_id, at);

  -- Past broadcasts (VODs) that Twitch still keeps
  CREATE TABLE IF NOT EXISTS vods (
    video_id     TEXT PRIMARY KEY,
    login        TEXT NOT NULL,
    stream_id    TEXT,
    created_at   TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    view_count   INTEGER,
    title        TEXT
  );
  CREATE INDEX IF NOT EXISTS vods_stream ON vods (login, stream_id);

  -- Categories (games) and the link to their picture on Twitch. box_art_url is NULL if Twitch didn't find the category.
  DROP INDEX IF EXISTS vods_login;

  CREATE TABLE IF NOT EXISTS categories (
    name        TEXT PRIMARY KEY,
    box_art_url TEXT
  );
`);

// Older databases lack the followers column in snapshots: add it
const columns = db.prepare("PRAGMA table_info(snapshots)").all().map((c) => c.name);
if (!columns.includes("followers")) db.exec("ALTER TABLE snapshots ADD COLUMN followers INTEGER");

module.exports = db;
