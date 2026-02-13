let rawMessages = [];
let rawAliases = [];
let selectedAliases = new Set(); // ID degli alias selezionati

// --- AUTH & INIT ---
async function checkAuth() {
    try {
        const res = await fetch('/api/check-auth');
        const data = await res.json();
        if(data.authed) showDashboard();
    } catch(e) { console.error(e); }
}

async function login() {
    const code = document.getElementById('auth-code').value;
    const res = await fetch('/api/login', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ code })
    });
    if((await res.json()).success) showDashboard();
    else document.getElementById('login-error').style.display='block';
}

function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    loadData(true); // true = primo caricamento, seleziona tutto di default
}

// --- DATA LOGIC ---
async function loadData(firstLoad = false) {
    try {
        const res = await fetch('/api/data');
        if(res.status === 401) return location.reload();
        const data = await res.json();

        rawAliases = data.aliases;
        rawMessages = data.messages;

        // Se è il primo avvio o se ci sono nuovi alias, aggiungili alla selezione di default
        // Nota: Manteniamo lo stato di selezione corrente
        if(firstLoad) {
            rawAliases.forEach(a => selectedAliases.add(a.id));
        }

        renderDisk(data.disk);
        renderAliases();
        renderMail();
    } catch(e) { console.error("Err loadData", e); }
}

async function forceRefresh() {
    // Animazione visuale
    const btn = document.querySelector('button[title="Aggiorna ora"]');
    btn.innerHTML = '...';
    await fetch('/api/refresh', { method: 'POST' });
    await loadData();
    btn.innerHTML = '↻';
}

// --- RENDERING ---
function renderDisk(disk) {
    document.getElementById('disk-stats').textContent = 
        `Disco: ${disk.percent || '?'}% (${disk.used} / ${disk.size})`;
}

function renderAliases() {
    const list = document.getElementById('alias-list');
    list.innerHTML = '';
    
    rawAliases.forEach(a => {
        const li = document.createElement('li');
        li.className = 'alias-item';
        const d = new Date(a.expires_at);
        const exp = a.expires_at === -1 ? '∞' : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        const isChecked = selectedAliases.has(a.id) ? 'checked' : '';

        li.innerHTML = `
            <div class="alias-left">
                <input type="checkbox" onchange="toggleAlias(${a.id}, this.checked)" ${isChecked}>
                <div style="min-width:0;">
                    <div class="alias-addr" onclick="copyToClipboard('${a.address}')" title="Clicca per copiare">${a.address}</div>
                    <div class="alias-exp">Scade: ${exp}</div>
                </div>
            </div>
            <div class="alias-actions">
                <button class="btn btn-sm" onclick="purgeAlias(${a.id})" title="Svuota mail vecchie">🧹</button>
                <button class="btn btn-sm btn-danger" onclick="deleteAlias(${a.id})" title="Elimina account">🗑</button>
            </div>
        `;
        list.appendChild(li);
    });
}
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function renderMail() {
    const container = document.getElementById('mail-list');
    container.innerHTML = '';

    // Filter logic
    const filtered = rawMessages.filter(m => selectedAliases.has(m.alias_id));
    document.getElementById('mail-count').textContent = `(${filtered.length})`;

    if(filtered.length === 0) {
        container.innerHTML = '<div style="padding:10px; text-align:center; color:#888">Nessun messaggio</div>';
        return;
    }

    filtered.forEach(m => {
        const div = document.createElement('div');
        div.className = 'mail-item';
        const date = new Date(m.received_at).toLocaleString();
        const paperclip = m.has_attachments ? ' 📎' : '';
        const sizeStr = formatBytes(m.size);
        
        // Trova alias name per visualizzazione
        const aliasName = rawAliases.find(a => a.id === m.alias_id)?.address || '?';

        div.innerHTML = `
            <div class="mail-info" onclick="openMail(${m.id})">
                <span class="mail-date">${date} • ${sizeStr}</span>
                <div class="mail-from">${m.from_addr}</div>
                <div class="mail-sub">${m.subject}${paperclip}</div>
                <span class="mail-date">[${aliasName}]</span>
                </div>
                <div class="mail-actions">
                <button class="btn btn-sm btn-danger" onclick="deleteMsg(${m.id})">🗑</button>
            </div>
        `;
        container.appendChild(div);
    });
}

// --- USER ACTIONS ---

// Alias Toggle
function toggleAlias(id, checked) {
    if(checked) selectedAliases.add(id);
    else selectedAliases.delete(id);
    renderMail();
}

function toggleSelectAll() {
    const allIds = rawAliases.map(a => a.id);
    if(selectedAliases.size === allIds.length) {
        selectedAliases.clear();
    } else {
        allIds.forEach(id => selectedAliases.add(id));
    }
    renderAliases();
    renderMail();
}

// Clipboard
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        // Feedback visuale minimo (es. cambio colore temporaneo)
        alert("Copiato: " + text); // Semplice e brutale come richiesto
    });
}

// Create Alias
async function createAlias() {
    const rawAddr = document.getElementById('new-alias').value;
    // Sostituisce tutto ciò che non è lettera, numero, punto o trattino con underscore
    const addr = rawAddr.replace(/[^a-z0-9.\-]/gi, '_');
    if(!addr) return;
    const dur = document.getElementById('duration').value;

    const res = await fetch('/api/aliases', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ address: addr, durationDays: dur })
    });
    if(res.ok) {
        document.getElementById('new-alias').value = '';
        loadData(true); // Ricarica e seleziona i nuovi
    } else {
        alert("Errore: alias forse già esistente");
    }
}

// Delete Alias
async function deleteAlias(id) {
    if(!confirm("Eliminare account e tutte le sue mail?")) return;
    await fetch(`/api/aliases/${id}`, { method: 'DELETE' });
    selectedAliases.delete(id);
    loadData();
}

// Purge Messages (Sweep)
async function purgeAlias(id) {
    const dateStr = prompt("Inserisci data LIMITE (YYYY-MM-DD).\nTutti i messaggi PRIMA di questa data verranno eliminati.");
    if(!dateStr) return;

    const timestamp = new Date(dateStr).getTime();
    if(isNaN(timestamp)) return alert("Data non valida");

    const res = await fetch(`/api/aliases/${id}/purge?before=${timestamp}`, { method: 'DELETE' });
    const data = await res.json();
    if(data.success) {
        alert(`Eliminati ${data.count} messaggi.`);
        loadData();
    }
}

// Delete Single Message
async function deleteMsg(id) {
    if(!confirm("Eliminare messaggio?")) return;
    await fetch(`/api/messages/${id}`, { method: 'DELETE' });
    // Rimuovi localmente per velocità
    rawMessages = rawMessages.filter(m => m.id !== id);
    renderMail();
}

// Open/Close Mail Viewer
function openMail(id) {
    const m = rawMessages.find(msg => msg.id === id);
    if(!m) return;

    document.getElementById('mail-view').classList.remove('hidden');
    document.getElementById('view-subject').textContent = m.subject;
    document.getElementById('view-from').textContent = m.from_addr;
    document.getElementById('view-to').textContent = m.alias_address;

    // --- GESTIONE ALLEGATI ---
    const metaDiv = document.querySelector('.modal-meta');
    // Rimuovi vecchi allegati se presenti
    const oldAtt = document.getElementById('att-list');
    if(oldAtt) oldAtt.remove();

    if(m.attachments_list && m.attachments_list.length > 0) {
        const attContainer = document.createElement('div');
        attContainer.id = 'att-list';
        attContainer.style.paddingTop = '10px';
        attContainer.innerHTML = '<strong>Allegati:</strong> ';

        m.attachments_list.forEach(att => {
            const link = document.createElement('a');
            link.href = `/api/attachments/${att.id}`;
            link.target = '_blank';
            link.innerText = `[${att.filename} (${formatBytes(att.size)})]`;
            link.style.marginRight = '10px';
            link.style.textDecoration = 'none';
            link.style.color = 'var(--primary)';
            attContainer.appendChild(link);
        });
        metaDiv.appendChild(attContainer);
    }
    // -------------------------

    const wrapper = document.getElementById('mail-content-wrapper');
    wrapper.innerHTML = '';
    const iframe = document.createElement('iframe');
    wrapper.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    // Aggiungo <base target="_blank"> per aprire i link in nuova scheda (Punto 6)
    doc.write(`<head><base target="_blank"></head>`);
    doc.write(`<style>body{font-family:sans-serif; padding:10px; margin:0; word-wrap: break-word;}</style>`);
    doc.write(m.body_html || `<pre style="white-space:pre-wrap">${m.body_text}</pre>`);
    doc.close();
}

function closeMail() {
    document.getElementById('mail-view').classList.add('hidden');
    // Pulisci iframe per memoria
    document.getElementById('mail-content-wrapper').innerHTML = '';
}

// Start
checkAuth();
