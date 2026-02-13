const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const cookieSession = require('cookie-session');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = 'mailmanager.db';
const AUTH_CODE = '1234';

// --- CONFIGURAZIONE IMAP (Modifica questi dati) ---
const IMAP_CONFIG = {
    imap: {
        user: 'sterzomail@.alwaysdata.net', // La tua mail reale catch-all
        password: 'SterzoMail115!',
        host: 'imap.alwaysdata.net',
        port: 993,
        tls: true,
        authTimeout: 3000
    }
};

// --- DATABASE SETUP ---
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE,
        expires_at INTEGER,
        created_at INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias_id INTEGER,
        from_addr TEXT,
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        received_at INTEGER,
        FOREIGN KEY(alias_id) REFERENCES aliases(id) ON DELETE CASCADE
    )`);
});

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));
app.use(cookieSession({
    name: 'session',
    keys: ['chiave_super_segreta_random'],
    maxAge: 24 * 60 * 60 * 1000 // 24 ore
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ error: 'Non autorizzato' });
};

// --- FUNZIONI UTILI ---

// Controlla spazio su disco (Linux)
function getDiskUsage(callback) {
    exec('df -h .', (error, stdout, stderr) => {
        if (error) { return callback("Errore"); }
        const lines = stdout.trim().split('\n');
        const diskInfo = lines[1] ? lines[1].split(/\s+/) : [];
        // Filesystem, Size, Used, Avail, Use%, Mounted
        callback(null, {
            size: diskInfo[1],
            used: diskInfo[2],
            avail: diskInfo[3],
            percent: diskInfo[4]
        });
    });
}

// Fetch Mail & Cleanup
async function fetchMailAndCleanup() {
    console.log("Controllo mail ed eliminazione scaduti...");
    const now = Date.now();

    // 1. Elimina alias scaduti e i loro messaggi
    db.run(`DELETE FROM aliases WHERE expires_at < ? AND expires_at != -1`, [now], function(err) {
        if(!err && this.changes > 0) console.log(`Rimossi ${this.changes} alias scaduti.`);
    });
    // Nota: messages si pulisce grazie al CASACADE, ma sqlite richiede PRAGMA foreign_keys=ON. 
    // Per semplicità facciamo una pulizia manuale orfani se necessario, ma qui ci fidiamo del codice.
    db.run(`DELETE FROM messages WHERE alias_id NOT IN (SELECT id FROM aliases)`);

    // 2. Leggi mail via IMAP
    try {
        const connection = await imap.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');
        
        const searchCriteria = ['UNSEEN'];
        const fetchOptions = { bodies: ['HEADER', 'TEXT', ''], markSeen: true }; // Scarica tutto
        
        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            connection.end();
            return;
        }

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const idHeader = "imap-" + id;
            
            const parsed = await simpleParser(all.body);
            
            // Logica cruciale: A chi è diretta?
            // "parsed.to" è un array o oggetto. Controlliamo se uno dei destinatari è nel nostro DB.
            let targetAlias = null;
            
            // Otteniamo lista alias attivi
            const activeAliases = await new Promise((resolve) => {
                db.all("SELECT * FROM aliases", [], (err, rows) => resolve(rows));
            });

            if (parsed.to && Array.isArray(parsed.to.value)) {
                for (let recipient of parsed.to.value) {
                    const found = activeAliases.find(a => recipient.address.toLowerCase() === a.address.toLowerCase());
                    if (found) {
                        targetAlias = found;
                        break;
                    }
                }
            }

            if (targetAlias) {
                // Salva messaggio
                db.run(`INSERT INTO messages (alias_id, from_addr, subject, body_text, body_html, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
                    [targetAlias.id, parsed.from.text, parsed.subject, parsed.text, parsed.html || parsed.textAsHtml, Date.now()]
                );
                console.log(`Mail salvata per ${targetAlias.address}`);
                // Cancella dal server IMAP per risparmiare spazio (l'abbiamo salvata in DB locale)
                await connection.deleteMessage(id);
            } else {
                // Mail non per noi o alias scaduto -> Cancella dal server
                console.log(`Mail ignorata (destinatario sconosciuto): ${parsed.subject}`);
                await connection.deleteMessage(id);
            }
        }
        
        connection.end();
    } catch (e) {
        console.error("Errore IMAP:", e);
    }
}

// Esegui fetch ogni 2 minuti
setInterval(fetchMailAndCleanup, 120 * 1000);
// Esegui all'avvio
setTimeout(fetchMailAndCleanup, 5000);


// --- API ---

// Login
app.post('/api/login', (req, res) => {
    if (req.body.code === AUTH_CODE) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.get('/api/check-auth', (req, res) => {
    res.json({ authed: req.session && req.session.authenticated });
});

// Dashboard Data
app.get('/api/data', requireAuth, (req, res) => {
    const now = Date.now();
    
    const p1 = new Promise((resolve) => {
        db.all(`SELECT * FROM aliases ORDER BY created_at DESC`, [], (err, rows) => {
            // Aggiungi flag scaduto
            const result = rows.map(r => ({
                ...r,
                is_expired: (r.expires_at !== -1 && r.expires_at < now)
            }));
            resolve(result);
        });
    });

    const p2 = new Promise((resolve) => {
        db.all(`SELECT messages.*, aliases.address as alias_address 
                FROM messages 
                JOIN aliases ON messages.alias_id = aliases.id 
                ORDER BY received_at DESC`, [], (err, rows) => resolve(rows));
    });

    const p3 = new Promise((resolve) => getDiskUsage((err, data) => resolve(data || {})));

    Promise.all([p1, p2, p3]).then(([aliases, messages, disk]) => {
        res.json({ aliases, messages, disk });
    });
});

// Crea Alias
app.post('/api/aliases', requireAuth, (req, res) => {
    const { address, durationDays } = req.body;
    if (!address) return res.status(400).json({ error: 'Manca indirizzo' });
    
    // Calcola scadenza
    let expiresAt = -1;
    if (durationDays !== 'inf') {
        expiresAt = Date.now() + (parseInt(durationDays) * 24 * 60 * 60 * 1000);
    }

    db.run(`INSERT INTO aliases (address, expires_at, created_at) VALUES (?, ?, ?)`,
        [address, expiresAt, Date.now()],
        function(err) {
            if (err) return res.status(500).json({ error: 'Alias già esistente o errore DB' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Elimina Alias
app.delete('/api/aliases/:id', requireAuth, (req, res) => {
    db.run(`DELETE FROM aliases WHERE id = ?`, [req.params.id], (err) => {
        // Cascade dovrebbe pulire i messaggi, altrimenti il fetch loop lo farà
        db.run(`DELETE FROM messages WHERE alias_id = ?`, [req.params.id]);
        res.json({ success: true });
    });
});

// Server Start
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
