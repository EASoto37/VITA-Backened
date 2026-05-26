const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({limit: '10mb'}));

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

    const searchPrompt = `You are a real estate market intelligence system. Search the web RIGHT NOW for active investment property listings.

Run searches for these queries:
${searches.map((s,i) => `${i+1}. "${s}"`).join('\n')}

For EACH real listing you find, provide:
- Full property address (street, city, state, zip)
- Property type
- Asking price (exact dollar amount)
- Number of units or size
- Cap rate if listed
- Days on market if available  
- Direct URL to listing on LoopNet, Zillow, Crexi, or Realtor.com
- Listing broker/agent name if shown

Format as numbered list. Include ONLY real listings with real addresses and real prices you actually found. Minimum 8 properties. Include the clickable URL for each.`;

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`VITA Backend running on port ${PORT}`);
});
