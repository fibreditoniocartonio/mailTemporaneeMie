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

// --- CONFIGURAZIONE IMAP ---
const IMAP_CONFIG = {
    imap: {
        user: 'sterzomail@alwaysdata.net',
        password: 'SterzoMail115!',
        host: 'imap-sterzomail.alwaysdata.net',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000
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
        size INTEGER DEFAULT 0,
        has_attachments INTEGER DEFAULT 0,
        FOREIGN KEY(alias_id) REFERENCES aliases(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER,
        filename TEXT,
        content_type TEXT,
        data BLOB,
        size INTEGER,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    )`);
    const baseMail = IMAP_CONFIG.imap.user; // account senza alias
    db.run(`INSERT OR IGNORE INTO aliases (address, expires_at, created_at) VALUES (?, -1, ?)`,
           [baseMail, Date.now()]
    );
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
function getFolderSizeSync(dirPath) {
    let size = 0;
    const files = fs.readdirSync(dirPath);
    for (let i = 0; i < files.length; i++) {
        const filePath = path.join(dirPath, files[i]);
        try {
            const stats = fs.statSync(filePath);
            if (stats.isFile()) size += stats.size;
            else if (stats.isDirectory()) size += getFolderSizeSync(filePath);
        } catch (e) { }
    }
    return size;
}

function getDiskUsage(callback) {
    const limitMB = 100; // Limite Alwaysdata

    if (process.platform === "win32") {
        // --- LOGICA PER WINDOWS (LOCALE) ---
        try {
            const usedBytes = getFolderSizeSync('.');
            const usedMB = (usedBytes / (1024 * 1024)).toFixed(2);
            const percent = Math.round((usedMB / limitMB) * 100);
            callback(null, {
                size: limitMB + ' MB',
                used: usedMB + ' MB',
                avail: (limitMB - usedMB).toFixed(2) + ' MB',
                percent: percent
            });
        } catch (e) {
            callback(null, { size: '?', used: '?', avail: '?', percent: '0%' });
        }
    } else {
        // --- LOGICA PER LINUX (ALWAYSDATA) ---
        exec('du -sk .', (error, stdout) => {
            if (error) return callback(null, { size: '?', used: '?', avail: '?', percent: '0%' });
            const usedKB = parseInt(stdout.trim().split(/\s+/)[0]);
            const usedMB = (usedKB / 1024).toFixed(2);
            const percent = Math.round((usedMB / limitMB) * 100);
            callback(null, {
                size: limitMB + ' MB',
                used: usedMB + ' MB',
                avail: (limitMB - usedMB).toFixed(2) + ' MB',
                percent: percent
            });
        });
    }
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
            const msgSize = all.body.length || item.attributes.size || 0;
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
                // Gestione Allegati
                const hasAttachments = parsed.attachments && parsed.attachments.length > 0 ? 1 : 0;

                // Salva messaggio con size e flag allegati
                db.run(`INSERT INTO messages (alias_id, from_addr, subject, body_text, body_html, received_at, size, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                       [targetAlias.id, parsed.from.text, parsed.subject, parsed.text, parsed.html || parsed.textAsHtml, Date.now(), msgSize, hasAttachments],
                       function(err) {
                           if (err) return console.error(err);
                           const newMsgId = this.lastID;

                           // Salva Allegati se ci sono
                           if (hasAttachments) {
                               parsed.attachments.forEach(att => {
                                   db.run(`INSERT INTO attachments (message_id, filename, content_type, data, size) VALUES (?, ?, ?, ?, ?)`,
                                          [newMsgId, att.filename, att.contentType, att.content, att.size]
                                   );
                               });
                           }
                       }
                );

                console.log(`Mail salvata per ${targetAlias.address}`);
                await connection.deleteMessage(id);
            } else {
                console.log(`Mail ignorata: ${parsed.subject}`);
                await connection.deleteMessage(id);
            }
        }
        connection.imap.expunge((err) => {
            if(err) console.error("Errore Expunge:", err);
            else console.log("Expunge completato (spazio liberato).");
        });
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
            if (err) return resolve([]); // Gestione errore base
            let result = rows.map(r => ({
                ...r,
                is_expired: (r.expires_at !== -1 && r.expires_at < now)
            }));
            const baseMail = IMAP_CONFIG.imap.user;
            const baseAccount = result.find(r => r.address === baseMail);
            const others = result.filter(r => r.address !== baseMail);
            if (baseAccount) {
                result = [...others, baseAccount];
            }
            resolve(result);
        });
    });

    const p2 = new Promise((resolve) => {
        const sql = `
        SELECT m.*, a.address as alias_address,
        (SELECT json_group_array(json_object('id', att.id, 'filename', att.filename, 'size', att.size))
        FROM attachments att WHERE att.message_id = m.id) as attachments_json
        FROM messages m
        JOIN aliases a ON m.alias_id = a.id
        ORDER BY received_at DESC
        `;
        db.all(sql, [], (err, rows) => {
            if(rows) {
                // Parse del JSON string restituito da sqlite
                rows.forEach(r => {
                    if(r.attachments_json) r.attachments_list = JSON.parse(r.attachments_json);
                    else r.attachments_list = [];
                });
            }
            resolve(rows || []);
        });
    });

    const p3 = new Promise((resolve) => getDiskUsage((err, data) => resolve(data || {})));

    Promise.all([p1, p2, p3]).then(([aliases, messages, disk]) => {
        res.json({ aliases, messages, disk });
    });
});

// Download Allegato
app.get('/api/attachments/:id', requireAuth, (req, res) => {
    db.get(`SELECT * FROM attachments WHERE id = ?`, [req.params.id], (err, row) => {
        if (!row) return res.status(404).send('Not found');
        res.setHeader('Content-Type', row.content_type);
        res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
        res.send(row.data);
    });
});

// Crea Alias
app.post('/api/aliases', requireAuth, (req, res) => {
    let { address, durationDays } = req.body;

    // Forza il formato corretto: sterzomail+tag@alwaysdata.net
    if (!address.startsWith('sterzomail+')) {
        address = 'sterzomail+' + address;
    }
    if (!address.endsWith('@alwaysdata.net')) {
        address = address + '@alwaysdata.net';
    }

    let expiresAt = -1;
    if (durationDays !== 'inf') {
        expiresAt = Date.now() + (parseInt(durationDays) * 24 * 60 * 60 * 1000);
    }

    db.run(`INSERT INTO aliases (address, expires_at, created_at) VALUES (?, ?, ?)`,
           [address.toLowerCase(), expiresAt, Date.now()],
           function(err) {
               if (err) return res.status(500).json({ error: 'Etichetta già usata' });
               res.json({ success: true, fullAddress: address });
           }
    );
});

// Elimina Alias
app.delete('/api/aliases/:id', requireAuth, (req, res) => {
    db.get(`SELECT address FROM aliases WHERE id = ?`, [req.params.id], (err, row) => {
        if (row && row.address === IMAP_CONFIG.imap.user) {
            return res.status(403).json({ error: 'Impossibile eliminare account base' });
        }
        db.run(`DELETE FROM aliases WHERE id = ?`, [req.params.id], (err) => {
            db.run(`DELETE FROM messages WHERE alias_id = ?`, [req.params.id]);
            res.json({ success: true });
        });
    });
});

// Elimina singole Mail
app.delete('/api/messages/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    // Cancella il messaggio dal DB
    db.run(`DELETE FROM messages WHERE id = ?`, [id], function(err) {
        if (err) {
            console.error("Errore cancellazione msg:", err);
            return res.status(500).json({ success: false });
        }
        // Nota: Gli allegati vengono cancellati automaticamente grazie al CASCADE impostato nel DB
        res.json({ success: true });
    });
});

// Elimina messaggi antecedenti la data comunicata (bottone scopa)
app.delete('/api/aliases/:id/purge', requireAuth, (req, res) => {
    const aliasId = req.params.id;
    const beforeTimestamp = parseInt(req.query.before);

    if (!beforeTimestamp) {
        return res.status(400).json({ error: 'Data limite mancante' });
    }

    db.run(`DELETE FROM messages WHERE alias_id = ? AND received_at < ?`,
           [aliasId, beforeTimestamp],
           function(err) {
               if (err) {
                   console.error("Errore durante il purge:", err);
                   return res.status(500).json({ success: false });
               }
               console.log(`Purge completato: eliminati ${this.changes} messaggi.`);
               res.json({ success: true, count: this.changes });
           }
    );
});

// Forza controllo posta
app.post('/api/refresh', requireAuth, async (req, res) => {
    try {
        await fetchMailAndCleanup();
        res.json({ success: true });
    } catch (e) {
        console.error("Errore refresh manuale:", e);
        res.status(500).json({ error: 'Errore durante il recupero mail' });
    }
});

// Server Start
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
