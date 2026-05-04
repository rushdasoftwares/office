const express = require("express");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState, delay } = require("@whiskeysockets/baileys");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

let isWhatsappReady = false;

const session = require('express-session');   // <-- ADD THIS
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24*60*60*1000 }
}));

// ---------------- LOGIN SYSTEM -----------------

const USERS_FILE = '../users.json';

// Simple function to load users.json
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        return [];   // No users file â†' no users
    }
    try {
        const data = fs.readFileSync(USERS_FILE);
        return JSON.parse(data);
    } catch (e) {
        console.error('Could not read users.json:', e);
        return [];
    }
}

// LOGIN API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const users = loadUsers();

    const found = users.find(
        u => u.username === username && u.password === password
    );

    if (!found) {
        return res.json({ ok: false, error: "Invalid username or password" });
    }

    req.session.user = { username: found.username };
    res.json({ ok: true });
});

// Middleware to protect dashboard
function requireLogin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, error: "Not authenticated" });
    }
    next();
}

// Example protected route
app.get('/api/check', requireLogin, (req, res) => {
    res.json({ ok: true });
});

// --------------- END LOGIN SYSTEM ----------------

let latestQR = "";
let sock; // whatsapp socket

// ------------------------------
// FILE UPLOAD SETTINGS
// ------------------------------
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "./uploads");
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ------------------------------
// SHOW QR IN BROWSER
// ------------------------------
app.get("/qr", async (req, res) => {
    if (!latestQR) {
        return res.send("<h3>QR not ready. Please wait or restart server.</h3>");
    }

    try {
        const qrImage = await QRCode.toDataURL(latestQR);

        res.send(`
            <html>
            <body style="text-align:center;font-family:Arial;">
            <h2>Scan WhatsApp QR</h2>
            <img src="${qrImage}" />
            </body>
            </html>
        `);
    } catch (err) {
        res.send("QR generation error");
    }
});

// ------------------------------
// START WHATSAPP CONNECTION
// ------------------------------
async function startWhatsapp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");

    const { version } = await require("@whiskeysockets/baileys").fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ["Chrome (Linux)", "", ""]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { qr, connection, lastDisconnect } = update;

        // ? FIX: store QR properly
        if (qr) {
            latestQR = qr;
            console.log("? QR RECEIVED ? Open http://localhost:3000/qr");
        }

        // ? Connected
        if (connection === "open") {
            isWhatsappReady = true;
            latestQR = ""; // clear QR after connect
            console.log("?? WhatsApp Connected");
        }

        // ? Disconnected
        if (connection === "close") {
            isWhatsappReady = false;

            const reason = lastDisconnect?.error?.output?.statusCode;

            console.log("?? Connection closed:", reason);

            // reconnect unless logged out
            if (reason !== 401) {
                console.log("?? Reconnecting...");
                setTimeout(startWhatsapp, 3000);
            } else {
                console.log("?? Logged out. Delete /auth folder and restart.");
            }
        }
    });
}

startWhatsapp();

// ------------------------------
// SEND TEXT MESSAGE
// ------------------------------
app.post("/send-text", async (req, res) => {
    try {
        const { number, message } = req.body;

        await sock.sendMessage(number + "@s.whatsapp.net", { text: message });

        res.json({ status: true, msg: "Text message sent!" });
    } catch (e) {
        res.json({ status: false, error: e.message });
    }
});

// ------------------------------
// SEND IMAGE MESSAGE
// ------------------------------
app.post("/send-image", upload.single("file"), async (req, res) => {
    try {
        const { number, caption } = req.body;
        const filePath = req.file.path;

        await sock.sendMessage(number + "@s.whatsapp.net", {
            image: { url: filePath },
            caption: caption || ""
        });

        res.json({ status: true, msg: "Image sent!" });
    } catch (e) {
        res.json({ status: false, error: e.message });
    }
});

// ------------------------------
// SEND PDF MESSAGE
// ------------------------------
app.post("/send-pdf", upload.single("file"), async (req, res) => {
    try {
        const { number } = req.body;
        const filePath = req.file.path;

        await sock.sendMessage(number + "@s.whatsapp.net", {
            document: { url: filePath },
            mimetype: "application/pdf",
            fileName: req.file.originalname
        });

        res.json({ status: true, msg: "PDF sent!" });
    } catch (e) {
        res.json({ status: false, error: e.message });
    }
});
// ------------------------------
// SEND BULK TEXT MESSAGE
// ------------------------------
app.post("/api/send-bulk", async (req, res) => {
    const { numbers, message } = req.body;

    if (!numbers || !message) {
        return res.json({ ok: false, error: "Numbers or message missing" });
    }

    let success = 0;
    let failed = 0;

    for (let num of numbers) {
        const id = num.replace(/\D/g, "") + "@s.whatsapp.net";

        try {
            await sock.sendMessage(id, { text: message });
            success++;
        } catch (err) {
            failed++;
        }

        await delay(500);  // small delay to avoid blocking
    }

    res.json({
        ok: true,
        success,
        failed
    });
});
// -------------------------------
// SEND API TEXT
//--------------------------------
app.get("/send-text", async (req, res) => {
    try {
        const number = req.query.number;
        const message = req.query.message;

        await sock.sendMessage(number + "@s.whatsapp.net", { text: message });

        res.send("Message sent!");
    } catch (e) {
        res.send("Error: " + e.message);
    }
});

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        server: "awake"
    });
});

app.get("/whatsapp-status", (req, res) => {
    res.json({
        ready: isWhatsappReady
    });
});

// START SERVER
// ------------------------------
app.listen(3000, () => {
    console.log("SERVER RUNNING â†' http://localhost:3000");
    console.log("Scan QR â†' http://localhost:3000/qr");
});

// -------------------------------------------------------
// ðŸ"¥ ADD ANTI-SLEEP CODE AFTER app.listen()
// -------------------------------------------------------

setInterval(() => {
    fetch("https://office-2her.onrender.com/health")
        .catch(() => {});
}, 8 * 60 * 1000); // ping every 8 minutes