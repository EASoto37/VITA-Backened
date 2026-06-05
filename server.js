const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({limit: '10mb'}));

// ── POSTGRES (persistent memory) ──
// Render Postgres requires SSL; rejectUnauthorized:false matches the
// self-signed cert chain on the managed instance.
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDb(){
  if(!pool){ console.warn('[VITA db] DATABASE_URL not set — persistence disabled'); return; }
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS agent_memory (id SERIAL PRIMARY KEY, agent_name VARCHAR(20), messages JSONB, updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vita_contacts (id SERIAL PRIMARY KEY, data JSONB, updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vita_pipeline (id SERIAL PRIMARY KEY, data JSONB, updated_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vita_properties (id SERIAL PRIMARY KEY, data JSONB, updated_at TIMESTAMP DEFAULT NOW())`);
    console.log('[VITA db] tables ready');
  }catch(err){
    console.error('[VITA db] init failed:', err.message);
  }
}
initDb();

const DATA_TABLES = { contacts: 'vita_contacts', pipeline: 'vita_pipeline', properties: 'vita_properties' };

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ 
    status: 'VITA Backend Online', 
    time: new Date().toISOString(),
    services: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      gmail: !!process.env.GMAIL_USER,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY
    }
  });
});

// ── ANTHROPIC CHAT ──
app.post('/api/chat', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ELEVENLABS TTS ──
app.post('/api/speak', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const { text } = req.body;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '4BAlflaQyhIcCfHiEI7x';
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true }
      })
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const buffer = await response.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ELEVENLABS SPEECH-TO-TEXT ──
// The browser records the command (MediaRecorder) and sends it here as base64
// JSON: { audio: "<base64>", mimeType: "audio/webm" }. We forward it to the
// ElevenLabs Scribe STT API as multipart/form-data and return { text }.
// Multipart is built by hand so no extra npm deps (multer/form-data) are needed.
app.post('/api/transcribe', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio provided' });
    if (!process.env.ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ElevenLabs key not configured' });

    const audioBuffer = Buffer.from(audio, 'base64');
    const type = mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
    const boundary = '----VitaFormBoundary' + Date.now().toString(16);

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\n` +
      `scribe_v1\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="command.${ext}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
      'utf8'
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, audioBuffer, epilogue]);

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('STT error:', response.status, err.slice(0, 300));
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json({ text: data.text || '', raw: data });
  } catch (err) {
    console.error('Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({ error: 'Gmail credentials not configured' });
    }
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });
    await transporter.sendMail({
      from: `"Edward Soto | Vita Capital" <${process.env.GMAIL_USER}>`,
      to, subject,
      text: body,
      html: body.replace(/\n/g, '<br>')
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GMAIL INBOX — ALL unread messages (subject + sender + body + attachments) ──
// Reads the inbox over IMAP using the same Gmail App Password used for sending.
// Requires `imapflow` in package.json and IMAP enabled on the Gmail account.
// Degrades gracefully (returns an empty list + error) if either is missing so
// the rest of the backend keeps working.
//
// Walks bodyStructure to (a) pull the first text/plain (fallback: text/html
// stripped to text) body and (b) collect attachment metadata
// {partId, filename, size, contentType}. The attachment bytes themselves are
// NOT downloaded here — the frontend asks for them via /api/email/attachment
// when the user actually opens one. Caps body at ~5000 chars to keep payloads
// reasonable.

// bodyStructure is a tree of parts. Walk it depth-first and collect:
//   - first text/plain part (textPart)
//   - first text/html part (htmlPart) as fallback
//   - all parts whose disposition is 'attachment' or that have a filename
function walkBodyStructure(node, out){
  if(!node) return;
  if(Array.isArray(node.childNodes) && node.childNodes.length){
    for(const c of node.childNodes) walkBodyStructure(c, out);
    return;
  }
  const type = (node.type || '').toLowerCase();
  const disp = (node.disposition || '').toLowerCase();
  const params = node.dispositionParameters || {};
  const tparams = node.parameters || {};
  const filename = params.filename || tparams.name || null;
  if(disp === 'attachment' || (filename && type !== 'text/plain' && type !== 'text/html')){
    out.attachments.push({
      partId: node.part || '1',
      filename: filename || ('attachment.' + (type.split('/')[1] || 'bin')),
      size: node.size || 0,
      contentType: type
    });
  } else if(type === 'text/plain' && !out.textPart){
    out.textPart = node.part || '1';
  } else if(type === 'text/html' && !out.htmlPart){
    out.htmlPart = node.part || '1';
  }
}

function stripHtml(html){
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function streamToString(stream){
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// Query params:
//   filter=unread (default)     — only UNSEEN, last 20
//   filter=all                  — every message in INBOX, last 50 (read + unread)
//   filter=from&sender=<query>  — IMAP FROM-header search, last 50
// Response shape is unchanged: { count, emails, inboxTotal, filter }.
app.get('/api/emails', async (req, res) => {
  const filter = String(req.query.filter || 'unread').toLowerCase();
  const sender = String(req.query.sender || '').trim();
  console.log('[VITA emails] ── /api/emails START ── filter=' + filter + (sender ? ' sender=' + sender : ''));
  console.log('[VITA emails] GMAIL_USER:', process.env.GMAIL_USER ? `SET (${process.env.GMAIL_USER})` : 'NOT SET');
  console.log('[VITA emails] GMAIL_APP_PASSWORD:', process.env.GMAIL_APP_PASSWORD ? `SET (len=${process.env.GMAIL_APP_PASSWORD.length})` : 'NOT SET');
  if(filter === 'from' && !sender){
    return res.status(400).json({ error: 'filter=from requires sender query parameter', count: 0, emails: [] });
  }
  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      console.error('[VITA emails] Missing credentials — aborting');
      return res.status(500).json({ error: 'Gmail credentials not configured', count: 0, emails: [] });
    }
    let ImapFlow;
    try {
      ({ ImapFlow } = await import('imapflow'));
      console.log('[VITA emails] imapflow module loaded ✓');
    } catch (e) {
      console.error('[VITA emails] imapflow import failed:', e.message);
      return res.status(501).json({ error: 'imapflow not installed — run `npm install imapflow` and redeploy', count: 0, emails: [] });
    }

    console.log('[VITA emails] Connecting to imap.gmail.com:993 (TLS) as', process.env.GMAIL_USER);
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false
    });

    const emails = [];
    let mailboxInfo = null;
    try {
      await client.connect();
      console.log('[VITA emails] IMAP connection established ✓');
    } catch (connErr) {
      console.error('[VITA emails] IMAP CONNECT FAILED:', connErr.message);
      console.error('[VITA emails] (If "Invalid credentials" — confirm App Password is the 16-char one from Google Account → Security → App passwords, NOT the regular Gmail password)');
      return res.status(500).json({ error: 'IMAP connect failed: ' + connErr.message, count: 0, emails: [] });
    }

    const lock = await client.getMailboxLock('INBOX');
    try {
      mailboxInfo = client.mailbox;
      console.log('[VITA emails] INBOX opened — total messages:', mailboxInfo && mailboxInfo.exists);

      // Pick UID set based on filter. Each branch yields a `pickedUids` array
      // already capped to the right size, then we fall through to one shared
      // fetch + body-download loop.
      let pickedUids = [];
      let cap = 20;
      if(filter === 'all'){
        cap = 50;
        const total = (mailboxInfo && mailboxInfo.exists) || 0;
        if(total > 0){
          // Sequence numbers are 1..exists; newest is `exists`. Fetch the last
          // `cap` sequence numbers, collect their UIDs, then sort newest-first.
          const start = Math.max(1, total - cap + 1);
          const range = start + ':' + total;
          const uids = [];
          for await (const m of client.fetch(range, { uid: true })) uids.push(m.uid);
          pickedUids = uids.sort((a,b)=>b-a).slice(0, cap);
        }
        console.log('[VITA emails] ALL: picked', pickedUids.length, 'UIDs (cap=' + cap + ')');
      } else if(filter === 'from'){
        cap = 50;
        // imapflow's FROM search matches the From header (substring, case-insensitive).
        const hits = await client.search({ from: sender }, { uid: true }) || [];
        pickedUids = hits.slice().sort((a,b)=>b-a).slice(0, cap);
        console.log('[VITA emails] FROM "' + sender + '": ' + hits.length + ' hits → picked ' + pickedUids.length);
      } else {
        // default: unread
        const unseen = await client.search({ seen: false }, { uid: true }) || [];
        console.log('[VITA emails] UNSEEN UIDs returned by server:', unseen.length, '(first 5:', unseen.slice(0, 5).join(','), ')');
        pickedUids = unseen.slice().reverse().slice(0, cap);
      }

      const order = pickedUids;
      console.log('[VITA emails] Will fetch envelope+bodyStructure for', order.length, 'message(s)');
      if (order.length) {
        for await (const msg of client.fetch(order, { envelope: true, bodyStructure: true, flags: true }, { uid: true })) {
          const env = msg.envelope || {};
          const f = (env.from && env.from[0]) ? env.from[0] : {};
          const parts = { textPart: null, htmlPart: null, attachments: [] };
          if(msg.bodyStructure) walkBodyStructure(msg.bodyStructure, parts);

          // Download the body part. Prefer text/plain; fall back to stripped HTML.
          // Mark unread-preserving (peek) so the message stays UNSEEN after fetch.
          let body = '';
          const pick = parts.textPart || parts.htmlPart;
          if(pick){
            try {
              const dl = await client.download(msg.uid, pick, { uid: true });
              if(dl && dl.content){
                const raw = await streamToString(dl.content);
                body = parts.textPart ? raw : stripHtml(raw);
              }
            } catch(dlErr){
              console.warn('[VITA emails] body download failed for uid', msg.uid, dlErr.message);
            }
          }
          if(body.length > 5000) body = body.slice(0, 5000) + '\n…[truncated]';

          // flags is a Set in imapflow; \\Seen indicates read.
          let unread = true;
          try {
            if(msg.flags){
              if(typeof msg.flags.has === 'function') unread = !msg.flags.has('\\Seen');
              else if(Array.isArray(msg.flags)) unread = !msg.flags.includes('\\Seen');
            }
          } catch(e){}

          emails.push({
            uid: msg.uid,
            subject: env.subject || '(no subject)',
            from: f.name || f.address || 'Unknown',
            fromAddress: f.address || '',
            date: env.date || null,
            body: body.trim(),
            attachments: parts.attachments,
            unread
          });
        }
      }
      // Newest-first across all branches (envelope dates can drift from UID order).
      emails.sort((a,b)=>{
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });
      console.log('[VITA emails] Fetch complete — assembled', emails.length, 'records');
    } finally {
      lock.release();
    }
    await client.logout();
    console.log('[VITA emails] Logged out. Returning count=', emails.length);
    res.json({ count: emails.length, emails, inboxTotal: mailboxInfo ? mailboxInfo.exists : null, filter, sender: filter === 'from' ? sender : undefined });
  } catch (err) {
    console.error('[VITA emails] IMAP error:', err && err.message, err && err.stack);
    res.status(500).json({ error: err.message, count: 0, emails: [] });
  }
});

// ── PARSE ARBITRARY UPLOADED PDF ──
// POST /api/parse-pdf { base64, filename } → { text, pages, filename }
// Used by the ARIA Deal Analysis drop zone: the browser reads a dropped PDF
// as base64 via FileReader and posts it here so pdf-parse can extract text
// (pdf-parse runs in Node, not the browser). Caps body at 25MB.
app.post('/api/parse-pdf', async (req, res) => {
  try {
    const { base64, filename } = req.body || {};
    if(!base64) return res.status(400).json({ error: 'base64 required' });
    let buf;
    try { buf = Buffer.from(base64, 'base64'); }
    catch(e){ return res.status(400).json({ error: 'invalid base64' }); }
    if(buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'PDF too large (max 25MB)' });
    let pdfParse;
    try { pdfParse = require('pdf-parse'); }
    catch(e){ return res.status(501).json({ error: 'pdf-parse not installed — run `npm install pdf-parse` and redeploy' }); }
    const parsed = await pdfParse(buf);
    res.json({ filename: filename || 'document.pdf', text: parsed.text || '', pages: parsed.numpages || 0, size: buf.length });
  } catch (err) {
    console.error('[VITA parse-pdf] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── EMAIL ATTACHMENT DOWNLOAD + PDF TEXT EXTRACTION ──
// POST /api/email/attachment { uid, partId }
// Connects to IMAP, downloads the specified MIME part, and if it's a PDF runs
// pdf-parse to extract text. Returns { filename, contentType, size, text, base64 }.
// For non-PDFs we return base64 so the frontend can offer it as a download.
app.post('/api/email/attachment', async (req, res) => {
  try {
    const { uid, partId } = req.body || {};
    if(!uid || !partId) return res.status(400).json({ error: 'uid and partId required' });
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({ error: 'Gmail credentials not configured' });
    }
    let ImapFlow;
    try { ({ ImapFlow } = await import('imapflow')); }
    catch(e){ return res.status(501).json({ error: 'imapflow not installed' }); }

    const client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let payload = null, meta = null;
    try {
      const dl = await client.download(Number(uid), String(partId), { uid: true });
      if(!dl || !dl.content) throw new Error('attachment part not found');
      meta = dl.meta || {};
      const chunks = [];
      for await (const c of dl.content) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      payload = Buffer.concat(chunks);
    } finally { lock.release(); }
    await client.logout();

    const filename = (meta && (meta.filename || meta.name)) || ('attachment-' + uid + '-' + partId);
    const contentType = (meta && meta.contentType) || 'application/octet-stream';
    const isPdf = /pdf/i.test(contentType) || /\.pdf$/i.test(filename);

    let text = '';
    if(isPdf){
      try {
        const pdfParse = require('pdf-parse');
        const parsed = await pdfParse(payload);
        text = parsed.text || '';
      } catch(pdfErr){
        console.error('[VITA attachment] pdf-parse failed:', pdfErr.message);
        return res.status(500).json({ error: 'pdf-parse failed: ' + pdfErr.message + ' (run `npm install pdf-parse` and redeploy)', filename, contentType, size: payload.length });
      }
    }

    res.json({
      filename, contentType, size: payload.length,
      text,
      base64: isPdf ? null : payload.toString('base64')
    });
  } catch (err) {
    console.error('[VITA attachment] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MORNING BRIEFING — Real property search ──
app.get('/api/briefing', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const searches = [
      'quadplex for sale Dallas Fort Worth Texas site:loopnet.com OR site:zillow.com',
      'multifamily apartment complex for sale DFW Texas 2025',
      '4 plex fourplex for sale Dallas TX under 800000',
      'multifamily for sale Fort Worth TX value add',
      'RV park for sale Texas 2025',
      'self storage facility for sale Texas',
      'car wash for sale DFW Texas'
    ];

    const searchPrompt = `You must return specific individual property listings with real street addresses. Format each as: ADDRESS | PRICE | TYPE | URL. Do not return category counts or summaries. Find minimum 5 real listings from loopnet.com, crexi.com, zillow.com, perryguestcompany.com, svn.com, or greysteel.com with actual street addresses in Dallas Fort Worth Texas.

Run these web searches and read the listing pages:
${searches.map((s,i) => `${i+1}. ${s}`).join('\n')}

STRICT RULES:
- Each line is ONE specific individual property listing — never a market summary, search page, broker bio, neighborhood, ZIP, or city-wide aggregate.
- Each line MUST have a REAL street address: street number + street name (St/Ave/Blvd/Rd/Dr/Ln/Way/Pkwy/Ct/Pl/Hwy) + city + state. No "Undisclosed", no "Confidential", no city-only entries.
- Never invent or autocomplete. If a field is missing on the listing page, write "N/A".
- No duplicates. No counts, summaries, headers, intros, or commentary — output ONLY the numbered list.
- Every URL must link to the specific listing page (not a search results page or homepage).

EXACT OUTPUT FORMAT — one property per line, pipe-delimited:

1. <full street address — number + street + city + state> | <asking price or N/A> | <property type> | <direct listing URL>
2. <full street address — number + street + city + state> | <asking price or N/A> | <property type> | <direct listing URL>
3. ...`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        system: 'You are VITA market intelligence. Search for real active investment property listings with real addresses, prices, and URLs. Never make up listings.',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: searchPrompt }]
      })
    });

    const data = await response.json();
    let properties = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') properties += block.text;
      }
    }

    if (data.error) {
      console.error('Briefing search error:', data.error);
      return res.status(500).json({ error: JSON.stringify(data.error) });
    }

    res.json({
      timestamp: new Date().toISOString(),
      properties,
      status: 'complete'
    });
  } catch (err) {
    console.error('Briefing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AGENT MEMORY (persistent agent chat history) ──
// Each agent keeps one row; on save we replace the existing row so the table
// stays tiny (5 agents → 5 rows). agent_name is uppercased to match the
// frontend's AGENT_NAMES (ARIA/VERA/LYRA/OPUS/NOVA).
app.post('/api/memory/save', async (req, res) => {
  if(!pool) return res.status(503).json({ error: 'Database not configured' });
  try{
    const { agent, messages } = req.body || {};
    if(!agent) return res.status(400).json({ error: 'agent required' });
    const name = String(agent).toUpperCase();
    await pool.query('DELETE FROM agent_memory WHERE agent_name = $1', [name]);
    await pool.query('INSERT INTO agent_memory (agent_name, messages) VALUES ($1, $2)', [name, JSON.stringify(messages || [])]);
    res.json({ success: true });
  }catch(err){
    console.error('[VITA memory.save] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/load', async (req, res) => {
  if(!pool) return res.status(503).json({ error: 'Database not configured', messages: [] });
  try{
    const name = String(req.query.agent || '').toUpperCase();
    if(!name) return res.status(400).json({ error: 'agent required', messages: [] });
    const { rows } = await pool.query('SELECT messages FROM agent_memory WHERE agent_name = $1 ORDER BY updated_at DESC LIMIT 1', [name]);
    res.json({ agent: name, messages: rows[0] ? rows[0].messages : [] });
  }catch(err){
    console.error('[VITA memory.load] error:', err.message);
    res.status(500).json({ error: err.message, messages: [] });
  }
});

// ── DATA (contacts / pipeline / properties) ──
// Same one-row-per-table pattern: delete then insert keeps a single current
// snapshot per data type without needing a unique constraint on JSONB.
app.post('/api/data/save', async (req, res) => {
  if(!pool) return res.status(503).json({ error: 'Database not configured' });
  try{
    const { type, data } = req.body || {};
    const table = DATA_TABLES[type];
    if(!table) return res.status(400).json({ error: 'invalid type — must be contacts, pipeline, or properties' });
    await pool.query(`DELETE FROM ${table}`);
    await pool.query(`INSERT INTO ${table} (data) VALUES ($1)`, [JSON.stringify(data ?? [])]);
    res.json({ success: true });
  }catch(err){
    console.error('[VITA data.save] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data/load', async (req, res) => {
  if(!pool) return res.status(503).json({ error: 'Database not configured', data: [] });
  try{
    const table = DATA_TABLES[req.query.type];
    if(!table) return res.status(400).json({ error: 'invalid type', data: [] });
    const { rows } = await pool.query(`SELECT data FROM ${table} ORDER BY updated_at DESC LIMIT 1`);
    res.json({ type: req.query.type, data: rows[0] ? rows[0].data : [] });
  }catch(err){
    console.error('[VITA data.load] error:', err.message);
    res.status(500).json({ error: err.message, data: [] });
  }
});

// ── SCHEDULED AGENT JOBS ──────────────────────────────────────────────────
// Now that we have a database, the backend autonomously runs four agents on
// timers and appends their findings to agent_memory so the frontend sees
// them next time it loads agent histories.
//
//   ARIA  → 7am daily       → web-search market scan, results to ARIA memory
//   NOVA  → every 30 min    → Gmail IMAP scan, flagged emails to NOVA memory
//   VERA  → 8am daily       → rent-check tick to VERA memory (tenants live on
//                              the client; backend logs the scheduled tick and
//                              a marker the client picks up on load)
//   OPUS  → 8am daily       → RFI/submittal tick to OPUS memory (same pattern)
//
// All four are best-effort and gated on `pool` (no DB → no scheduling).

async function appendAgentMessage(agent, content){
  if(!pool) return;
  try{
    const name = String(agent).toUpperCase();
    const { rows } = await pool.query('SELECT messages FROM agent_memory WHERE agent_name = $1 ORDER BY updated_at DESC LIMIT 1', [name]);
    const existing = (rows[0] && Array.isArray(rows[0].messages)) ? rows[0].messages : [];
    existing.push({ role: 'assistant', content, ts: Date.now(), source: 'scheduled' });
    // Cap history at 200 messages so the row doesn't grow forever.
    const trimmed = existing.slice(-200);
    await pool.query('DELETE FROM agent_memory WHERE agent_name = $1', [name]);
    await pool.query('INSERT INTO agent_memory (agent_name, messages) VALUES ($1, $2)', [name, JSON.stringify(trimmed)]);
    console.log(`[VITA sched] appended message to ${name} (history now ${trimmed.length})`);
  }catch(err){
    console.error('[VITA sched] appendAgentMessage failed:', err.message);
  }
}

function msUntilNextLocal(hour){
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if(next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// ARIA — daily morning market search at 7am local time.
async function ariaMarketScan(){
  console.log('[VITA sched] ARIA market scan starting…');
  if(!process.env.ANTHROPIC_API_KEY){
    console.warn('[VITA sched] ARIA: ANTHROPIC_API_KEY missing — skipping');
    return;
  }
  try{
    const fetch = (await import('node-fetch')).default;
    const searches = [
      'site:loopnet.com dallas fort worth multifamily quadplex for sale',
      'site:crexi.com texas multifamily for sale',
      'site:zillow.com dallas units multifamily for sale',
      'site:perryguestcompany.com dallas listings',
      'site:svn.com dallas commercial multifamily for sale',
      'site:greysteel.com dallas multifamily listing'
    ];
    const prompt = `You must return specific individual property listings with real street addresses. Format each as: ADDRESS | PRICE | TYPE | URL. Do not return category counts or summaries. Find minimum 5 real listings from loopnet.com, crexi.com, zillow.com, perryguestcompany.com, svn.com, or greysteel.com with actual street addresses in Dallas Fort Worth Texas.\n\nSearches:\n${searches.map((s,i)=>`${i+1}. ${s}`).join('\n')}\n\nOutput ONLY the numbered list, one property per line, pipe-delimited.`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 3000,
        system: 'You are ARIA, VITA market intelligence. Return only real listings with real street addresses.',
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    let text = '';
    if(data.content) for(const b of data.content){ if(b.type === 'text') text += b.text; }
    if(!text){ console.warn('[VITA sched] ARIA: empty response'); return; }
    await appendAgentMessage('ARIA', `[Morning market scan ${new Date().toISOString()}]\n${text}`);
    // Also write the latest scan to vita_properties? No — properties is the
    // user-owned PM data. ARIA's scan stays in agent_memory.
  }catch(err){
    console.error('[VITA sched] ARIA scan failed:', err.message);
  }
}

// NOVA — Gmail unread scan every 30 minutes.
async function novaInboxScan(){
  console.log('[VITA sched] NOVA inbox scan starting…');
  if(!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD){
    console.warn('[VITA sched] NOVA: Gmail creds missing — skipping');
    return;
  }
  try{
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      host: 'imap.gmail.com', port: 993, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false
    });
    const flagged = [];
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try{
      const unseen = await client.search({ seen: false }, { uid: true }) || [];
      const order = unseen.slice().reverse().slice(0, 20);
      if(order.length){
        for await (const msg of client.fetch(order, { envelope: true, bodyStructure: true }, { uid: true })){
          const env = msg.envelope || {};
          const f = (env.from && env.from[0]) ? env.from[0] : {};
          const subject = env.subject || '(no subject)';
          const parts = { textPart: null, htmlPart: null, attachments: [] };
          if(msg.bodyStructure) walkBodyStructure(msg.bodyStructure, parts);
          // Importance heuristic: subject/sender OR an attached PDF/doc (likely
          // contract, OM, T12, rent roll).
          const lc = (subject + ' ' + (f.address||'')).toLowerCase();
          const hasDocAttachment = parts.attachments.some(a => /pdf|word|excel|sheet|document/i.test(a.contentType || '') || /\.(pdf|docx?|xlsx?)$/i.test(a.filename || ''));
          const important = hasDocAttachment || /loi|offer|contract|wire|closing|lender|appraisal|earnest|broker|due diligence|signed|approved|funded/.test(lc);
          flagged.push({ subject, from: f.name || f.address || 'Unknown', date: env.date || null, important, attachmentCount: parts.attachments.length });
        }
      }
    } finally { lock.release(); }
    await client.logout();
    const importantCount = flagged.filter(e => e.important).length;
    const summary = `[Inbox scan ${new Date().toISOString()}] ${flagged.length} unread, ${importantCount} flagged important.\n` +
      flagged.slice(0, 10).map(e => `${e.important ? '⚑ ' : '  '}${e.from} — ${e.subject}${e.attachmentCount ? ' [' + e.attachmentCount + ' attachment' + (e.attachmentCount===1?'':'s') + ']' : ''}`).join('\n');
    await appendAgentMessage('NOVA', summary);
  }catch(err){
    console.error('[VITA sched] NOVA scan failed:', err.message);
  }
}

// VERA — daily 8am rent check tick. Tenant data lives on the client; the
// backend logs the scheduled tick so the frontend sees a "checked" marker.
async function veraRentCheck(){
  console.log('[VITA sched] VERA rent check tick…');
  await appendAgentMessage('VERA', `[Rent check ${new Date().toISOString()}] Scheduled daily rent review ran. Client should re-evaluate pmTenants and surface any late accounts to the user.`);
}

// OPUS — daily 8am RFI/submittal overdue tick (same client-side pattern).
async function opusRfiCheck(){
  console.log('[VITA sched] OPUS RFI/submittal check tick…');
  await appendAgentMessage('OPUS', `[RFI/submittal check ${new Date().toISOString()}] Scheduled daily review ran. Client should re-evaluate subItems and surface any overdue RFIs or submittals.`);
}

if(pool){
  // ARIA at 7am, then every 24h.
  setTimeout(function ariaTick(){
    ariaMarketScan().finally(()=> setTimeout(ariaTick, 24*60*60*1000));
  }, msUntilNextLocal(7));
  console.log(`[VITA sched] ARIA scheduled — first run in ${Math.round(msUntilNextLocal(7)/60000)} min (7am local)`);

  // VERA + OPUS at 8am, then every 24h.
  setTimeout(function veraTick(){
    veraRentCheck().finally(()=> setTimeout(veraTick, 24*60*60*1000));
  }, msUntilNextLocal(8));
  setTimeout(function opusTick(){
    opusRfiCheck().finally(()=> setTimeout(opusTick, 24*60*60*1000));
  }, msUntilNextLocal(8));
  console.log(`[VITA sched] VERA + OPUS scheduled — first run in ${Math.round(msUntilNextLocal(8)/60000)} min (8am local)`);

  // NOVA every 30 min. First run after 2 min so server warm-up doesn't race
  // the very first IMAP connect.
  setTimeout(function novaTick(){
    novaInboxScan().finally(()=> setTimeout(novaTick, 30*60*1000));
  }, 2*60*1000);
  console.log('[VITA sched] NOVA scheduled — every 30 min, first run in 2 min');
} else {
  console.warn('[VITA sched] no DATABASE_URL — scheduled agents disabled');
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`VITA Backend running on port ${PORT}`);
});
