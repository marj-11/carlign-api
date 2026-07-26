// server.js — deploy this as a Render "Web Service".
// This is the ONLY thing that ever talks to Upstash directly — the Redis
// token lives here as a server-side environment variable and is never
// sent to the browser or visible on your website.
//
// Required environment variables (set in Render -> your service -> Environment):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   ALLOWED_ORIGIN   (optional — e.g. https://yourdomain.at ; defaults to "*")
//
// Accounts are name-only, no password. A name is claimed on a first-come
// basis: whoever picks it first keeps it, and everyone else is told it's
// taken. The browser remembers your name locally (localStorage on the
// front end), so returning players aren't asked again.

const express = require('express');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Runs one Redis command through Upstash's REST API,
// e.g. redis(['HGET', 'player:alice', 'bestGold'])
async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function isValidName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 14;
}

// Atomically claims a name: HSETNX only sets the field if it isn't already
// there, so two people racing to grab the same name can't both "win".
// Returns true if this call is the one that created the name, false if
// the name was already taken by an earlier claim.
async function claimName(name) {
  const result = await redis(['HSETNX', 'player:' + name, 'bestGold', '0']);
  return result === 1;
}

app.get('/', (req, res) => res.send('Carlign API is running.'));

app.post('/api/carlign', async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN' });
  }
  const { action, name, gold } = req.body || {};

  try {
    if (action === 'claim') {
      if (!isValidName(name)) return res.status(400).json({ error: 'Enter a name (1-14 characters)' });
      const ok = await claimName(name.trim());
      if (!ok) return res.status(409).json({ error: 'That name is already taken. Try another.' });
      return res.json({ ok: true });
    }

    if (action === 'submit') {
      if (!isValidName(name)) return res.status(400).json({ error: 'Invalid name' });
      const g = Number(gold);
      if (!Number.isFinite(g) || g < 0 || g > 100000) return res.status(400).json({ error: 'Invalid score' });
      await claimName(name.trim()); // harmless no-op if the name already exists
      const currentRaw = await redis(['HGET', 'player:' + name.trim(), 'bestGold']);
      const current = Number(currentRaw || 0);
      const best = Math.max(current, g);
      if (best > current) {
        await redis(['HSET', 'player:' + name.trim(), 'bestGold', String(best)]);
        await redis(['ZADD', 'carlign_leaderboard', String(best), name.trim()]);
      }
      return res.json({ ok: true, best });
    }

    if (action === 'leaderboard') {
      const raw = await redis(['ZREVRANGE', 'carlign_leaderboard', '0', '4', 'WITHSCORES']);
      const list = [];
      for (let i = 0; i < raw.length; i += 2) list.push({ name: raw[i], best_gold: Number(raw[i + 1]) });
      return res.json({ ok: true, list });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Carlign API listening on ' + PORT));
