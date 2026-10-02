const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let clientStatus = 'INITIALIZING';

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
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--js-flags=--max-old-space-size=200'
        ]
    }
});

client.on('qr', (qr) => {
    clientStatus = 'AWAITING_SCAN';
    QRCode.toDataURL(qr, (err, url) => {
        if (!err) currentQR = url;
    });
    console.log('📱 QR Code ready.');
});

client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    currentQR = null;
    console.log('✅ Authenticated.');
});

client.on('ready', () => {
    clientStatus = 'READY';
    currentQR = null;
    console.log('🤖 WhatsApp Agent is online and ready!');
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.body && msg.body.toLowerCase() === '!ping') {
        await msg.reply('pong! 🏓 Agent is running on Render.');
    }
});

// Intercept requests and block heavy assets (images, fonts, stylesheets) to save RAM
client.on('loading_screen', async () => {
    if (client.pupPage) {
        try {
            await client.pupPage.setRequestInterception(true);
            client.pupPage.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        } catch (_) {}
    }
});

client.initialize();

app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`<h2 style="color:green;text-align:center;">✅ WhatsApp Agent Connected!</h2>`);
    } else if (currentQR) {
        res.send(`<div style="text-align:center;"><h2>Scan QR Code</h2><img src="${currentQR}" width="280"/><script>setTimeout(()=>location.reload(),10000);</script></div>`);
    } else {
        res.send(`<div style="text-align:center;"><h2>Status: ${clientStatus}</h2><script>setTimeout(()=>location.reload(),4000);</script></div>`);
    }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
