const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let currentQR = null;
let clientStatus = 'STARTING';
let sock = null;

// Replace this with your actual external API URL (or leave blank for !ping test)
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || ''; 

async function startWhatsApp() {
    // Saves auth session in ./baileys_auth folder
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // suppress verbose logs
        printQRInTerminal: false
    });

    // Save session credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // Connection events (QR, Connected, Disconnected)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            clientStatus = 'AWAITING_SCAN';
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) currentQR = url;
            });
            console.log('📱 New QR code generated. Scan via web page.');
        }

        if (connection === 'open') {
            clientStatus = 'READY';
            currentQR = null;
            console.log('✅ WhatsApp Agent is ONLINE and READY! (Baileys - ~40MB RAM)');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            clientStatus = 'DISCONNECTED';
            console.log(`⚠️ Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startWhatsApp();
            }
        }
    });

    // Listen to messages (Incoming and Self)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const senderJid = msg.key.remoteJid;
            if (senderJid === 'status@broadcast') continue;

            // Extract message text (handles standard text and extended text)
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const isFromMe = msg.key.fromMe;

            console.log(`[Message from ${senderJid}]: ${text}`);

            // 1. Built-in test command !ping
            if (text.toLowerCase() === '!ping') {
                await sock.sendMessage(senderJid, { text: 'pong! 🏓 Agent is running stably on Baileys (RAM: ~45MB)!' });
                continue;
            }

            // 2. Forward to your external API (if URL is configured)
            if (EXTERNAL_API_URL && text && !isFromMe) {
                try {
                    console.log(`Forwarding message to ${EXTERNAL_API_URL}...`);
                    const apiResponse = await axios.post(EXTERNAL_API_URL, {
                        sender: senderJid,
                        senderName: msg.pushName || 'User',
                        messageText: text,
                        timestamp: msg.messageTimestamp
                    }, { timeout: 30000 });

                    const replyText = apiResponse.data?.reply || apiResponse.data?.message || apiResponse.data;
                    if (replyText) {
                        await sock.sendMessage(senderJid, { text: String(replyText) });
                    }
                } catch (err) {
                    console.error('External API error:', err.message);
                }
            }
        }
    });
}

startWhatsApp();

// --- Web Dashboard ---
app.get('/', (req, res) => {
    if (clientStatus === 'READY') {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2 style="color: #25D366;">✅ WhatsApp Agent is Online & Connected!</h2>
                    <p>Engine: <strong>Baileys (Ultra Low RAM ~45MB)</strong></p>
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <p>Send <code>!ping</code> on WhatsApp to test.</p>
                </body>
            </html>
        `);
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>📱 Scan this QR Code with WhatsApp</h2>
                    <img src="${currentQR}" width="280" style="border: 1px solid #ccc; padding: 10px; border-radius: 8px;" />
                    <p>Status: <strong>${clientStatus}</strong></p>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
                    <h2>⏳ WhatsApp Status: ${clientStatus}</h2>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                </body>
            </html>
        `);
    }
});

// --- API endpoint to send WhatsApp message from external servers ---
app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message"' });
    }
    if (!sock || clientStatus !== 'READY') {
        return res.status(503).json({ error: 'WhatsApp client is not ready' });
    }

    try {
        const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Sent successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
