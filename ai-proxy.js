// ai-proxy.js
const express = require('express');

// Use global fetch (Node 18+) or fallback
const fetchFn = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();
app.use(express.json());

// CORS on every request + OPTIONS early return
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const API_URL = 'https://api.openai.com/v1/chat/completions';
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) console.warn('[ai-proxy] Missing OPENAI_API_KEY in environment.');

app.post('/api/ai', async (req, res) => {
  try {
    // Ensure CORS headers on the actual response too
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { messages = [], model = 'gpt-4o', temperature = 0.7, max_tokens = 600 } = req.body || {};
    if (!API_KEY) return res.status(500).send('Server missing OPENAI_API_KEY');

    const upstream = await fetchFn(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).send(errText);
    }

    const json = await upstream.json();
    const reply = json.choices?.[0]?.message?.content || '';
    return res.json({ reply, usage: json.usage, raw: json });
  } catch (err) {
    console.error('[ai-proxy] error', err);
    res.status(500).send('AI proxy error');
  }
});

app.listen(PORT, () => {
  console.log(`[ai-proxy] listening on http://localhost:${PORT}`);
});
