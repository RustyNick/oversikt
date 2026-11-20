const API = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

const TIMEOUT_MS = 10 * 1000;

let token = null;
let tokenExpires = 0;
let tokenRequest = null; // token request in progress, so simultaneous calls share it

async function request(url, options) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const err = new Error(
      cause.name === "TimeoutError"
        ? "Twitch did not answer in time."
        : "Could not reach Twitch.",
    );
    err.status = 502;
    throw err;
  }
}

function hasKeys() {
  return Boolean(
    process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET,
  );
}

async function getToken(forceNew) {
  if (!hasKeys()) {
    const err = new Error(
      "TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are missing in the .env file.",
    );
    err.status = 500;
    throw err;
  }
  if (token && !forceNew && Date.now() < tokenExpires) return token;
  if (!tokenRequest)
    tokenRequest = requestToken().finally(() => {
      tokenRequest = null;
    });
  return tokenRequest;
}

async function requestToken() {
  const res = await request(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const err = new Error(
      "Twitch did not accept the keys in .env (status " + res.status + ").",
    );
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  token = data.access_token;
  tokenExpires = Date.now() + (data.expires_in - 300) * 1000;
  return token;
}

async function helix(endpoint, params, retried) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    for (const v of [].concat(value)) query.append(key, v);
  }
  const res = await request(API + endpoint + "?" + query, {
    headers: {
      "Client-Id": process.env.TWITCH_CLIENT_ID,
      Authorization: "Bearer " + (await getToken()),
    },
  });
  if (res.status === 401 && !retried) {
    await getToken(true);
    return helix(endpoint, params, true);
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 429
        ? "Twitch rate limit reached. Try again in a minute."
        : "Twitch API error (status " + res.status + ") on " + endpoint,
    );
    err.status = 502;
    throw err;
  }
  return res.json();
}

const getUser = async (login) =>
  (await helix("/users", { login })).data[0] || null;
const getLiveStreams = async (userIds) =>
  (await helix("/streams", { user_id: userIds, first: 100 })).data;
const getFollowerTotal = async (userId) =>
  (await helix("/channels/followers", { broadcaster_id: userId, first: 1 }))
    .total;
const getPastBroadcasts = async (userId) =>
  (await helix("/videos", { user_id: userId, type: "archive", first: 100 }))
    .data;

const getCategories = async (names) =>
  (await helix("/games", { name: names })).data; // at most 100 names per request

module.exports = {
  hasKeys,
  getUser,
  getLiveStreams,
  getFollowerTotal,
  getPastBroadcasts,
  getCategories,
};
