require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app    = express();
const PORT   = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '15mb' })); // CSV data can be large

// ─── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(movieData) {
  const ratings   = movieData.ratings   || [];
  const watchlist = movieData.watchlist || [];
  const watched   = movieData.watched   || [];
  const likes     = movieData.likes     || [];

  const sortedRatings = [...ratings].sort((a, b) => (b.rating || 0) - (a.rating || 0));

  const ratingLines = sortedRatings.map(m =>
    `- ${m.name} (${m.year})  ${starsFor(m.rating)}`
  ).join('\n');

  const watchlistLines = watchlist.slice(0, 300).map(m =>
    `- ${m.name} (${m.year})`
  ).join('\n');

  const watchedLines = watched
    .filter(w => !ratings.some(r => r.name === w.name && r.year === w.year))
    .slice(0, 150)
    .map(m => `- ${m.name} (${m.year})`)
    .join('\n');

  const likesLines = likes.slice(0, 200).map(m => `- ${m.name} (${m.year})`).join('\n');

  // Taste summary for Claude
  const avgRating = ratings.length
    ? (ratings.reduce((s, m) => s + (m.rating || 0), 0) / ratings.length).toFixed(2)
    : null;

  const decades = {};
  ratings.forEach(m => {
    const decade = m.year ? `${Math.floor(Number(m.year) / 10) * 10}s` : 'Unknown';
    decades[decade] = (decades[decade] || 0) + 1;
  });
  const topDecades = Object.entries(decades)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([d, n]) => `${d} (${n} films)`)
    .join(', ');

  return `You are a passionate, knowledgeable cinephile AI named "Letterboxd AI". \
You have intimate knowledge of the user's complete film history pulled directly from their Letterboxd account.

═══ FILM HISTORY OVERVIEW ═══
Total rated:     ${ratings.length} films
Average rating:  ${avgRating ? avgRating + ' / 5' : 'n/a'}
Watchlist:       ${watchlist.length} films
Watched total:   ${watched.length} films
Liked films:     ${likes.length} films
Top decades:     ${topDecades || 'n/a'}

═══ RATED FILMS (sorted by rating) ═══
${ratingLines || 'None uploaded yet.'}
${watchlistLines ? `\n═══ WATCHLIST ═══\n${watchlistLines}` : ''}
${watchedLines ? `\n═══ WATCHED (unrated) ═══\n${watchedLines}` : ''}
${likesLines ? `\n═══ LIKED FILMS (♥) ═══\n${likesLines}` : ''}

═══ INSTRUCTIONS ═══
- Speak like a fellow film lover, not a database query engine.
- Reference specific titles from their history naturally in conversation.
- When recommending films, explain WHY based on their actual taste patterns.
- Notice patterns: do they prefer slow cinema, arthouse, genre films, a specific era?
- Be honest — if their ratings suggest mainstream taste, say so diplomatically.
- Use ★ symbols for ratings. Keep responses focused and conversational.
- Never list more than 8–10 films in one response unless explicitly asked for a full list.
- If no CSV data is loaded, ask the user to upload their Letterboxd exports.`;
}

function starsFor(rating) {
  if (!rating) return '(unrated)';
  const full  = Math.floor(rating);
  const half  = rating % 1 >= 0.5 ? '½' : '';
  return '★'.repeat(full) + half + ` (${rating})`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: 'claude-sonnet-4-6', timestamp: new Date().toISOString() });
});

// Main chat endpoint — streams SSE back to the client
app.post('/api/chat', async (req, res) => {
  const { message, movieData, history = [] } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message required' });
  }

  // Build conversation messages (keep last 10 turns for context window efficiency)
  const messages = [
    ...history.slice(-20),
    { role: 'user', content: message.trim() },
  ];

  const systemPrompt = movieData
    ? buildSystemPrompt(movieData)
    : 'You are a cinephile AI. Tell the user to upload their Letterboxd CSV exports (ratings.csv, watchlist.csv, watched.csv) to get started.';

  // Set SSE headers before any await so the client gets them immediately
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering on Railway

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const stream = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
      stream:     true,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        send({ text: chunk.delta.text });
      }
    }

    send({ done: true });
    res.end();
  } catch (err) {
    console.error('Claude error:', err.message);
    send({ error: err.message });
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Letterboxd AI backend  →  http://localhost:${PORT}`);
  console.log(`API key loaded:           ${!!process.env.ANTHROPIC_API_KEY}`);
});
