const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'VITA Backend Online', time: new Date().toISOString() });
});

// ── PROXY ANTHROPIC API ──
// Keeps API key secure on server, not in browser
app.post('/api/chat', async (req, res) => {
  try {
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
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    const transporter = nodemailer.createTransporter({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
    await transporter.sendMail({
      from: `"Edward Soto | Vita Capital" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>')
    });
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── READ EMAILS ──
app.get('/api/emails', async (req, res) => {
  try {
    // Gmail API read using OAuth2
    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread',
      {
        headers: {
          'Authorization': `Bearer ${process.env.GMAIL_ACCESS_TOKEN}`
        }
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MORNING BRIEFING ──
app.get('/api/briefing', async (req, res) => {
  try {
    // This endpoint generates the morning briefing
    // Called by VITA on startup or on demand
    const briefing = {
      timestamp: new Date().toISOString(),
      status: 'ready',
      message: 'Morning briefing endpoint active. Connect email to populate.'
    };
    res.json(briefing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`VITA Backend running on port ${PORT}`);
});
