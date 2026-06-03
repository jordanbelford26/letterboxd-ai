/* ── Config ─────────────────────────────────────────────────────────────── */
// Change this to your Railway URL after deploy; keep localhost for local dev
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://letterboxd-ai-production.up.railway.app';

/* ── State ──────────────────────────────────────────────────────────────── */
const state = {
  movieData:  null,   // { ratings, watchlist, watched }
  history:    [],     // [{ role, content }] for Claude context
  streaming:  false,
};

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const $messages       = document.getElementById('messages');
const $input          = document.getElementById('chatInput');
const $sendBtn        = document.getElementById('sendBtn');
const $stats          = document.getElementById('stats');
const $promptsSection = document.getElementById('promptsSection');
const $promptsList    = document.getElementById('promptsList');
const $backendStatus  = document.getElementById('backendStatus');

/* ── CSV Parser ─────────────────────────────────────────────────────────── */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Find the header row (Letterboxd exports sometimes have metadata rows before it)
  let headerIdx = lines.findIndex(l => /^Date,Name/i.test(l));
  if (headerIdx === -1) headerIdx = 0;

  const headers = lines[headerIdx].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields with commas inside
    const fields = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur);

    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (fields[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function normaliseRatings(rows) {
  return rows
    .filter(r => r.name)
    .map(r => ({
      name:   r.name,
      year:   r.year,
      rating: r.rating ? parseFloat(r.rating) : null,
      date:   r.date,
    }));
}

function normaliseList(rows) {
  return rows
    .filter(r => r.name)
    .map(r => ({ name: r.name, year: r.year, date: r.date }));
}

/* ── File loading ───────────────────────────────────────────────────────── */
function setupFileInput(inputId, dropId, nameId, statusId, type) {
  const input  = document.getElementById(inputId);
  const drop   = document.getElementById(dropId);
  const nameEl = document.getElementById(nameId);
  const statEl = document.getElementById(statusId);

  function load(file) {
    if (!file || !file.name.endsWith('.csv')) return;
    const reader = new FileReader();
    reader.onload = e => {
      const rows = parseCSV(e.target.result);
      state.movieData = state.movieData || {};

      if (type === 'ratings') {
        state.movieData.ratings = normaliseRatings(rows);
        statEl.textContent = `${rows.length} films`;
      } else if (type === 'watchlist') {
        state.movieData.watchlist = normaliseList(rows);
        statEl.textContent = `${rows.length} films`;
      } else {
        state.movieData.watched = normaliseList(rows);
        statEl.textContent = `${rows.length} films`;
      }

      nameEl.textContent = file.name;
      drop.classList.add('loaded');
      updateStats();
    };
    reader.readAsText(file);
  }

  input.addEventListener('change', () => load(input.files[0]));

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    load(e.dataTransfer.files[0]);
  });
}

/* ── Stats panel ────────────────────────────────────────────────────────── */
const SUGGESTED_PROMPTS = [
  'What are the patterns in my taste?',
  'Which directors should I explore next?',
  'What's a perfect film I'd give 5 stars to?',
  'Roast my film taste, be honest.',
  'What genre am I clearly obsessed with?',
  'Give me a double feature for tonight.',
  'What's a hidden gem I'd probably love?',
  'Which of my 5-star films is the most underrated?',
];

function updateStats() {
  if (!state.movieData) return;
  const { ratings = [], watchlist = [], watched = [] } = state.movieData;
  if (!ratings.length && !watchlist.length && !watched.length) return;

  $stats.hidden = false;
  document.getElementById('statRated').textContent     = ratings.length;
  document.getElementById('statWatchlist').textContent = watchlist.length;
  document.getElementById('statWatched').textContent   = watched.length;

  const avg = ratings.length
    ? (ratings.reduce((s, m) => s + (m.rating || 0), 0) / ratings.length).toFixed(1)
    : '—';
  document.getElementById('statAvg').textContent = avg;

  // Top 5 rated
  const top = [...ratings]
    .filter(m => m.rating)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 5);

  if (top.length) {
    document.getElementById('topRated').innerHTML =
      '<div style="font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Top rated</div>' +
      top.map(m => `<div><strong>${escHtml(m.name)}</strong> (${m.year || '?'}) — ${starsStr(m.rating)}</div>`).join('');
  }

  // Suggested prompts (only show once data is loaded)
  if (ratings.length && $promptsList.children.length === 0) {
    $promptsSection.hidden = false;
    SUGGESTED_PROMPTS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'prompt-chip';
      btn.textContent = p;
      btn.addEventListener('click', () => sendMessage(p));
      $promptsList.appendChild(btn);
    });
  }
}

function starsStr(r) {
  if (!r) return '—';
  const full = Math.floor(r);
  return '★'.repeat(full) + (r % 1 >= 0.5 ? '½' : '');
}

/* ── Chat ───────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Very lightweight markdown → HTML (bold, italic, code, lists)
function renderMarkdown(text) {
  return text
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Unordered list items
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    // Numbered list
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Paragraphs (double newline)
    .replace(/\n{2,}/g, '</p><p>')
    // Single newlines become <br>
    .replace(/\n/g, '<br>')
    .replace(/^(?!<[hul])(.+)$/, '<p>$1</p>');
}

function appendMessage(role, content, streaming = false) {
  // Remove welcome screen on first message
  const welcome = $messages.querySelector('.welcome');
  if (welcome) welcome.remove();

  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'Letterboxd AI';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (streaming) {
    bubble.dataset.raw = '';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    bubble.appendChild(cursor);
  } else {
    bubble.innerHTML = renderMarkdown(escHtml(content));
  }

  wrapper.appendChild(label);
  wrapper.appendChild(bubble);
  $messages.appendChild(wrapper);
  $messages.scrollTop = $messages.scrollHeight;

  return bubble;
}

function streamToken(bubble, token) {
  bubble.dataset.raw = (bubble.dataset.raw || '') + token;
  const cursor = bubble.querySelector('.cursor');
  // Re-render accumulated text (cheap for typical response lengths)
  bubble.innerHTML = renderMarkdown(escHtml(bubble.dataset.raw));
  const newCursor = document.createElement('span');
  newCursor.className = 'cursor';
  bubble.appendChild(newCursor);
  $messages.scrollTop = $messages.scrollHeight;
}

function finaliseStream(bubble) {
  const raw = bubble.dataset.raw || '';
  bubble.innerHTML = renderMarkdown(escHtml(raw));
  delete bubble.dataset.raw;
  return raw;
}

async function sendMessage(text) {
  const message = (text || $input.value).trim();
  if (!message || state.streaming) return;

  $input.value = '';
  autoResize();
  state.streaming = true;
  $sendBtn.disabled = true;

  appendMessage('user', message);
  const assistantBubble = appendMessage('assistant', '', true);

  try {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        movieData: state.movieData,
        history:   state.history,
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const dec    = new TextDecoder();
    let buffer   = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // incomplete last line back to buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.text)  streamToken(assistantBubble, parsed.text);
          if (parsed.error) streamToken(assistantBubble, `\n\n*Error: ${parsed.error}*`);
          if (parsed.done)  break;
        } catch { /* ignore malformed chunks */ }
      }
    }

    const finalText = finaliseStream(assistantBubble);

    // Update conversation history for multi-turn context
    state.history.push({ role: 'user', content: message });
    state.history.push({ role: 'assistant', content: finalText });
    if (state.history.length > 40) state.history = state.history.slice(-40);

  } catch (err) {
    finaliseStream(assistantBubble);
    assistantBubble.innerHTML += `<br><em style="color:#ef4444;">Connection error — is the backend running?</em>`;
    console.error(err);
  } finally {
    state.streaming = false;
    $sendBtn.disabled = false;
    $input.focus();
  }
}

/* ── Input auto-resize ───────────────────────────────────────────────────── */
function autoResize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 180) + 'px';
}

$input.addEventListener('input', autoResize);
$input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$sendBtn.addEventListener('click', () => sendMessage());

/* ── Backend health check ────────────────────────────────────────────────── */
async function checkBackend(attempt = 1) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(`${API_BASE}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      $backendStatus.textContent = '● backend connected';
      $backendStatus.className   = 'backend-status ok';
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (err) {
    if (attempt < 3) {
      // Retry up to 3× — Railway may be cold-starting
      setTimeout(() => checkBackend(attempt + 1), 3000);
    } else {
      $backendStatus.textContent = '● backend offline';
      $backendStatus.className   = 'backend-status error';
    }
  }
}

/* ── Init ────────────────────────────────────────────────────────────────── */
setupFileInput('fileRatings',   'dropRatings',   'nameRatings',   'statusRatings',   'ratings');
setupFileInput('fileWatchlist', 'dropWatchlist', 'nameWatchlist', 'statusWatchlist', 'watchlist');
setupFileInput('fileWatched',   'dropWatched',   'nameWatched',   'statusWatched',   'watched');

checkBackend();
$input.focus();
