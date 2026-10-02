const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000; 

let currentQR = null;
let clientStatus = 'INITIALIZING';
let loadingPercent = 0;

// 1. Initialize WhatsApp Client with optimized memory flags for Render Free Tier (512MB RAM)
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wwebjs/web-paths/master/versions/{version}.html'
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--js-flags=--max-old-space-size=256'
        ]
    }
});

// 2. Events & Status Tracking
client.on('qr', (qr) => {
    clientStatus = 'AWAITING_SCAN';
    QRCode.toDataURL(qr, (err, url) => {
        if (!err) currentQR = url;
    });
    console.log('📱 New QR code generated. Waiting for scan...');
});

client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    currentQR = null; // Remove QR as soon as scanned
    console.log('✅ Client authenticated successfully! Waiting for chats to sync...');
});

client.on('loading_screen', (percent, message) => {
    clientStatus = 'SYNCING_CHATS';
    loadingPercent = percent;
    console.log(`⏳ Loading WhatsApp screen: ${percent}% - ${message}`);
});

client.on('ready', () => {
    clientStatus = 'READY';
    currentQR = null;
    console.log('🤖 WhatsApp Agent is online and ready to receive messages!');
});

client.on('auth_failure', (msg) => {
    clientStatus = 'AUTH_FAILURE';
    console.error('❌ Authentication failure:', msg);
});

client.on('disconnected', (reason) => {
    clientStatus = 'DISCONNECTED';
    console.log('⚠️ Client disconnected:', reason);
});

// 3. Message handler (Test with !ping)
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    console.log(`[Message from ${msg.from}]: ${msg.body}`);

    if (msg.body && msg.body.toLowerCase() === '!ping') {
        await msg.reply('pong! 🏓 Agent is running on Render.');
    }
});

// 4. Start WhatsApp
console.log('🚀 Initializing WhatsApp Web client...');
client.initialize();

// 5. Dashboard Web Page
app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #25D366;">✅ WhatsApp Agent is Online & Connected!</h2>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Send <code>!ping</code> from any WhatsApp chat to test the bot.</p>
                    <p><a href="/screenshot" target="_blank">View Browser Screen</a></p>
                </body>
            </html>
        `);
    } else if (clientStatus === 'AUTHENTICATED' || clientStatus === 'SYNCING_CHATS') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #0084FF;">⏳ WhatsApp is Syncing Chats (${loadingPercent}%)...</h2>
                    <p>Your phone has linked successfully! Please wait 15–30 seconds for the initial sync to finish.</p>
                    <p>This page will auto-refresh in 5 seconds...</p>
                    <script>setTimeout(() => { location.reload(); }, 5000);</script>
                    <p><a href="/screenshot" target="_blank">View Browser Screen</a></p>
                </body>
            </html>
        `);
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>📱 Scan this QR Code with WhatsApp</h2>
                    <img src="${currentQR}" alt="WhatsApp QR Code" style="width: 280px; height: 280px; border: 1px solid #ccc; padding: 10px; border-radius: 8px;" />
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Open WhatsApp on your phone &rarr; Linked Devices &rarr; Link a Device.</p>
                    <script>setTimeout(() => { location.reload(); }, 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>⏳ WhatsApp Status: ${clientStatus}</h2>
                    <p>Please wait a few seconds...</p>
                    <script>setTimeout(() => { location.reload(); }, 3000);</script>
                </body>
            </html>
        `);
    }
});

// 6. Screenshot endpoint to visually see what WhatsApp Web is showing
app.get('/screenshot', async (req, res) => {
    try {
        if (client.pupPage) {
            const image = await client.pupPage.screenshot({ encoding: 'binary' });
            res.contentType('image/jpeg');
            res.send(image);
        } else {
            res.send('Chromium page is not loaded yet.');
        }
    } catch (err) {
        res.status(500).send('Error capturing screenshot: ' + err.message);
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});
