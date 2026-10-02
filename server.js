const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let clientStatus = 'INITIALIZING';

// 1. Initialize WhatsApp Client with headless Chrome flags for Linux/Docker
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// 2. Events
client.on('qr', (qr) => {
    clientStatus = 'AWAITING_SCAN';
    QRCode.toDataURL(qr, (err, url) => {
        if (!err) currentQR = url;
    });
    console.log('New QR code received.');
});

client.on('ready', () => {
    clientStatus = 'READY';
    currentQR = null;
    console.log('🤖 WhatsApp Agent is online and ready!');
});

client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    console.log('Client authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    clientStatus = 'AUTH_FAILURE';
    console.error('Authentication failure:', msg);
});

// 3. Message handling (Add your AI agent logic here)
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    console.log(`[Message from ${msg.from}]: ${msg.body}`);

    // Simple test command
    if (msg.body.toLowerCase() === '!ping') {
        await msg.reply('pong! 🏓 Agent is running on Render.');
    }
    // You can connect your Gemini / OpenAI agent here
});

client.initialize();

// 4. Web Dashboard to view QR code and health status on Render
app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding-top: 50px;">
                    <h2 style="color: green;">✅ WhatsApp Agent is Online & Connected!</h2>
                    <p>Status: ${clientStatus}</p>
                </body>
            </html>
        `);
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding-top: 50px;">
                    <h2>📱 Scan this QR code with WhatsApp</h2>
                    <img src="${currentQR}" alt="WhatsApp QR Code" style="width: 280px; height: 280px;" />
                    <p>Refresh the page if the QR code expires.</p>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding-top: 50px;">
                    <h2>⏳ WhatsApp Client Status: ${clientStatus}</h2>
                    <p>Please wait a few seconds and refresh...</p>
                </body>
            </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

