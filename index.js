require('dotenv').config();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fetch = require('node-fetch');

const FIREBASE_URL = process.env.FIREBASE_URL;

const userStates = {};

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ FIREBASE_URL missing!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    // CONNECTION
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') console.log("✅ Panchayat Bot Online");

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // MESSAGE HANDLER
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log("📩", text);

        // ======================
        // STEP 2: SAVE COMPLAINT
        // ======================
        if (userStates[sender]?.step === 'WAITING_DETAILS') {

            const details = text;
            const issue = userStates[sender].issue;
            const phone = sender.split('@')[0];

            let category = "General";
            if (issue.includes("water")) category = "Water";
            else if (issue.includes("drain")) category = "Drain";
            else if (issue.includes("road")) category = "Road";
            else if (issue.includes("light")) category = "Street Light";

            const complaint = {
                userId: "whatsapp_" + phone,
                phone: phone,
                category: category,
                description: issue,
                details: details,
                status: "Pending",
                statusUpdated: false,
                notified: false,
                createdAt: new Date().toISOString()
            };

            try {
                await fetch(`${FIREBASE_URL}/complaints.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(complaint)
                });

                await sock.sendMessage(sender, {
                    text: `✅ మీ ఫిర్యాదు నమోదు అయింది!\n\n📌 సమస్య: ${issue}\n📊 స్థితి: Pending\n\nధన్యవాదాలు 🙏`
                });

            } catch (err) {
                console.log("Firebase Error:", err);
            }

            delete userStates[sender];
            return;
        }

        // ======================
        // STEP 1: START COMPLAINT
        // ======================
        if (text.startsWith("complaint")) {
            const issue = text.replace("complaint", "").trim();

            if (!issue) {
                await sock.sendMessage(sender, {
                    text: "⚠️ దయచేసి సమస్యను వ్రాయండి.\nExample: complaint water problem"
                });
                return;
            }

            userStates[sender] = {
                step: 'WAITING_DETAILS',
                issue: issue
            };

            await sock.sendMessage(sender, {
                text: `📝 ఫిర్యాదు నమోదు ప్రారంభం\n\nసమస్య: *${issue}*\n\nమీ పేరు, ఫోన్, చిరునామా పంపండి`
            });

            return;
        }

        // ======================
        // STATUS CHECK
        // ======================
        if (text.includes("status")) {
            const phone = sender.split('@')[0];

            try {
                const res = await fetch(`${FIREBASE_URL}/complaints.json`);
                const data = await res.json();

                if (!data) {
                    await sock.sendMessage(sender, { text: "❌ ఫిర్యాదులు లేవు" });
                    return;
                }

                let reply = "📊 మీ ఫిర్యాదులు:\n\n";

                Object.values(data).forEach(c => {
                    if (c.phone === phone) {
                        reply += `🔸 ${c.description} → ${c.status}\n`;
                    }
                });

                await sock.sendMessage(sender, { text: reply });

            } catch (err) {
                console.log(err);
            }

            return;
        }

        // ======================
        // GREETING
        // ======================
        if (text.includes("hi") || text.includes("hello")) {
            await sock.sendMessage(sender, {
                text: `👋 స్వాగతం!\n\n👉 complaint [problem]\n👉 status`
            });
            return;
        }

        // ======================
        // DEFAULT
        // ======================
        await sock.sendMessage(sender, {
            text: `🤖 అర్థం కాలేదు\n\n👉 complaint water problem\n👉 status`
        });
    });

    // ======================
    // AUTO STATUS UPDATE
    // ======================
    setInterval(async () => {
        try {
            const res = await fetch(`${FIREBASE_URL}/complaints.json`);
            const data = await res.json();

            if (!data) return;

            for (const id in data) {
                const c = data[id];

                if (c.statusUpdated && !c.notified) {
                    const jid = c.phone + "@s.whatsapp.net";

                    await sock.sendMessage(jid, {
                        text: `📢 మీ ఫిర్యాదు స్థితి: ${c.status}`
                    });

                    await fetch(`${FIREBASE_URL}/complaints/${id}.json`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ notified: true })
                    });
                }
            }

        } catch (err) {
            console.log("Auto update error:", err);
        }
    }, 10000);
}

startBot();
