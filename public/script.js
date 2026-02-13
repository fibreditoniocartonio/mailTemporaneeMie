let rawMessages = [];

// --- AUTH ---
async function checkAuth() {
    try {
        const res = await fetch('/api/check-auth');
        const data = await res.json();
        if(data.authed) showDashboard();
    } catch (e) {
        console.error("Errore check auth", e);
    }
}

async function login() {
    const code = document.getElementById('auth-code').value;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if(data.success) showDashboard();
        else document.getElementById('login-error').style.display = 'block';
    } catch (e) {
        alert("Errore di connessione");
    }
}

function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    loadData();
}

// --- DATA ---
async function loadData() {
    try {
        const res = await fetch('/api/data');
        if(res.status === 401) return location.reload();
        const data = await res.json();
        
        // Disk Stats
        const disk = data.disk;
        document.getElementById('disk-stats').textContent = 
            `Disco: ${disk.used || '?'} usato su ${disk.size || '?'} (${disk.percent || '?'}%)`;

        // Render Aliases
        const tbody = document.querySelector('#alias-table tbody');
        tbody.innerHTML = '';
        data.aliases.forEach(a => {
            const expDate = a.expires_at === -1 ? 'Mai' : new Date(a.expires_at).toLocaleDateString();
            const tr = document.createElement('tr');
            if(a.is_expired) tr.classList.add('expired');
            
            tr.innerHTML = `
                <td title="${a.address}" style="max-width:100px; overflow:hidden; text-overflow:ellipsis;">${a.address}</td>
                <td>${expDate}</td>
                <td><button class="btn btn-danger" style="padding:2px 6px; font-size:10px" onclick="deleteAlias(${a.id})">X</button></td>
            `;
            tbody.appendChild(tr);
        });

        // Render Messages List
        rawMessages = data.messages;
        renderMailList(data.messages);
    } catch (e) {
        console.error("Errore caricamento dati", e);
    }
}

function renderMailList(msgs) {
    const container = document.getElementById('mail-list');
    container.innerHTML = '';
    if(msgs.length === 0) {
        container.innerHTML = '<p style="padding:10px; color:#999;">Nessun messaggio.</p>';
        return;
    }

    msgs.forEach((m, idx) => {
        const div = document.createElement('div');
        div.className = 'mail-item';
        const date = new Date(m.received_at).toLocaleString();
        div.innerHTML = `
            <div class="mail-header"><span>${m.from_addr}</span> <small>${date}</small></div>
            <div class="mail-sub"><strong>[${m.alias_address}]</strong> ${m.subject}</div>
        `;
        div.onclick = () => openMail(idx);
        container.appendChild(div);
    });
}

// --- ACTIONS ---
async function createAlias() {
    const addr = document.getElementById('new-alias').value;
    const dur = document.getElementById('duration').value;
    if(!addr) return alert("Inserisci indirizzo");

    try {
        const res = await fetch('/api/aliases', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ address: addr, durationDays: dur })
        });
        
        if(res.ok) {
            document.getElementById('new-alias').value = '';
            loadData();
        } else {
            alert("Errore creazione. Forse esiste già?");
        }
    } catch (e) {
        alert("Errore durante la creazione");
    }
}

async function deleteAlias(id) {
    if(!confirm("Eliminare account e tutte le sue mail?")) return;
    try {
        await fetch(`/api/aliases/${id}`, { method: 'DELETE' });
        loadData();
    } catch (e) {
        alert("Errore durante l'eliminazione");
    }
}

function openMail(idx) {
    const m = rawMessages[idx];
    document.getElementById('mail-view').classList.remove('hidden');
    document.getElementById('view-subject').textContent = m.subject;
    document.getElementById('view-from').textContent = m.from_addr;
    document.getElementById('view-to').textContent = m.alias_address;
    
    // Usa iframe per visualizzare l'HTML in sicurezza
    const container = document.getElementById('mail-content');
    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    container.appendChild(iframe);
    
    // Scrivi dentro l'iframe
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(m.body_html || `<pre>${m.body_text}</pre>`);
    doc.close();
}

function closeMail() {
    document.getElementById('mail-view').classList.add('hidden');
}

// Avvia controllo auth all'apertura
checkAuth();