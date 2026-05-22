const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.json({ status: 'VITA Backend Online', time: new Date().toISOString() });
});

// ── PROXY ANTHROPIC API ──
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
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/api/send-email', async (req, res) => {
  try {
    const nodemailer = require('nodemailer');
    const { to, subject, body } = req.body;

    if(!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD){
      return res.status(500).json({ error: 'Gmail credentials not configured in environment variables' });
    }

    const transporter = nodemailer.createTransport({
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
      to: to,
      subject: subject,
      text: body,
      html: body.replace(/\n/g, '<br>')
    });

    res.json({ success: true, message: 'Email sent successfully from ' + process.env.GMAIL_USER });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── MORNING BRIEFING ──
app.get('/api/briefing', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    status: 'ready'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`VITA Backend running on port ${PORT}`);
});
