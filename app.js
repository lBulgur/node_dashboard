// --- HILFSFUNKTIONEN ---
function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- KONFIGURATION & UUIDS ---
const UUID_SVC   = 'b4250000-1141-4123-8ff6-334d52bc6603';
const UUID_MODE  = 'b4250001-1141-4123-8ff6-334d52bc6603';
const UUID_SENS  = 'b4250002-1141-4123-8ff6-334d52bc6603';
const UUID_RATE  = 'b4250003-1141-4123-8ff6-334d52bc6603';
const UUID_LIVE  = 'b4250004-1141-4123-8ff6-334d52bc6603';
const UUID_CMD   = 'b4250005-1141-4123-8ff6-334d52bc6603';
const UUID_CONF  = 'b4250006-1141-4123-8ff6-334d52bc6603';
const UUID_STAT  = 'b4250007-1141-4123-8ff6-334d52bc6603';

let device, gatt, svc;
let chars = {};
let sensorMetadata = [];
let charts = {};
let liveBuffer = "";
let configBuffer = "";
let lastDataTime = Date.now();
let disconnectTimer;
let dfuInProgress = false;
let configVersion = 0; // Zähler für Config-Empfang (inkrementiert bei jedem applyConfig)

// --- VERBINDUNG ---

function showToast(msg, durationMs = 4000) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#323130;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;text-align:center;max-width:90%;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, durationMs);
}

function resetDisconnectTimer() {
    clearTimeout(disconnectTimer);
    // Nach 5 Minuten (300.000 ms) ohne Datenempfang wird getrennt
    disconnectTimer = setTimeout(() => {
        if (gatt && gatt.connected) {
            console.log("Inaktivität erkannt. Trenne Verbindung zum Stromsparen...");
            disconnectBLE();
            showToast("Verbindung wegen Inaktivität getrennt (Stromsparmodus).", 6000);
        }
    }, 300000);
}

async function connectBLE() {
    try {
        resetAppState();
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID_SVC] }] });
        device.addEventListener('gattserverdisconnected', onDisconnected);
        
        gatt = await device.gatt.connect();
        svc = await gatt.getPrimaryService(UUID_SVC);
        
        chars.live = await svc.getCharacteristic(UUID_LIVE);
        chars.mode = await svc.getCharacteristic(UUID_MODE);
        chars.sens = await svc.getCharacteristic(UUID_SENS);
        chars.rate = await svc.getCharacteristic(UUID_RATE);
        chars.cmd  = await svc.getCharacteristic(UUID_CMD);
        chars.conf = await svc.getCharacteristic(UUID_CONF);
        chars.stat = await svc.getCharacteristic(UUID_STAT);

        // 1. Notifications scharf schalten
        await chars.conf.startNotifications();
        chars.conf.addEventListener('characteristicvaluechanged', (ev) => handleData(ev, "config"));

        await chars.live.startNotifications();
        chars.live.addEventListener('characteristicvaluechanged', (ev) => handleData(ev, "live"));

        await chars.stat.startNotifications();
        chars.stat.addEventListener('characteristicvaluechanged', (ev) => handleStatus(ev));
        
        // 2. Aktiv den Start-Status vom Arduino anfordern!
        console.log("Fordere Start-Status an...");
        configBuffer = ""; // Puffer sicherheitshalber leeren
        await chars.cmd.writeValue(new TextEncoder().encode('ping'));
        
        // Kurz warten, damit das Chunking (Häppchen-Senden) durchkommt
        await new Promise(r => setTimeout(r, 600));
        
        showView('view-main');
    } catch (e) { 
        console.error(e);
        alert("Fehler: " + e.message); 
    }
}

function handleStatus(ev) {
    const status = new TextDecoder().decode(ev.target.value);
    console.log("Status:", status);
    const btn = document.querySelector('#view-sensor-setup button[onclick="testSensor()"]');
    const resultDiv = document.getElementById('sc-test-result');
    if (status === 'warmup' && btn) {
        btn.textContent = 'Aufwärmen...';
        if (resultDiv) resultDiv.innerHTML = '<span style="color:#605e5c;">Sensor wärmt auf... Bitte warten.</span>';
    } else if (status === 'test_start' && btn) {
        btn.textContent = 'Messung läuft...';
    } else if (status === 'cal_ok') {
        const cs = document.getElementById('sc-hmc-cal-status');
        if (cs) { cs.textContent = 'Kalibrierung erfolgreich!'; cs.style.color = '#107c10'; }
    } else if (status === 'cal_fail') {
        const cs = document.getElementById('sc-hmc-cal-status');
        if (cs) { cs.textContent = 'Kalibrierung fehlgeschlagen'; cs.style.color = '#d83b01'; }
    } else if (status === 'ds_scanning') {
        const list = document.getElementById('sc-ds-probe-list');
        if (list) list.innerHTML = '<p style="color:#605e5c;">Scanne I2C-Bus...</p>';
    } else if (status === 'ds_done') {
        // Config-Push kommt automatisch mit den Ergebnissen
    } else if (status === 'dfu_reboot') {
        // Node springt in den Bootloader
        document.getElementById('dfu-status').textContent = 'Node startet Bootloader. Jetzt nRF DFU App öffnen.';
        document.getElementById('dfu-status').style.color = 'var(--success)';
        document.getElementById('dfu-buttons').classList.add('hidden');
    }
}

function handleData(ev, type) {
    resetDisconnectTimer();
    const chunk = new TextDecoder().decode(ev.target.value);
    
    if (type === "live") {
        liveBuffer += chunk;
        processJsonBuffer("live");
    } else {
        configBuffer += chunk;
        processJsonBuffer("config");
    }
}

function processJsonBuffer(type) {
    let buffer = (type === "live") ? liveBuffer : configBuffer;

    let startIdx = buffer.indexOf('{');
    if (startIdx === -1) return; // Noch kein JSON-Anfang da, weiter warten

    let openBraces = 0;
    let endIdx = -1;

    // Finde das exakte Ende des ERSTEN kompletten JSON-Objekts
    for (let i = startIdx; i < buffer.length; i++) {
        if (buffer[i] === '{') openBraces++;
        else if (buffer[i] === '}') {
            openBraces--;
            if (openBraces === 0) {
                endIdx = i;
                break; // Perfekt, wir haben ein in sich geschlossenes Objekt gefunden!
            }
        }
    }

    // Wenn wir ein komplettes Objekt gefunden haben
    if (endIdx !== -1) {
        let jsonStr = buffer.substring(startIdx, endIdx + 1);
        try {
            const data = JSON.parse(jsonStr);
            
            // Erfolgreich geparst! Daten anwenden und Puffer kürzen
            if (type === "live") {
                updateUI(data);
                liveBuffer = buffer.substring(endIdx + 1);
            } else {
                applyConfig(data);
                configBuffer = buffer.substring(endIdx + 1);
            }
            
            // Ganz wichtig: Falls noch ein zweites JSON im Puffer klebt, sofort nochmal aufrufen!
            if (buffer.length > endIdx + 2) {
                setTimeout(() => processJsonBuffer(type), 5);
            }
            
        } catch (e) {
            console.error("JSON Parse Fehler:", e);
            // Bei hartnäckigem Fehler (korrupte Daten) Puffer verwerfen
            if (type === "live") liveBuffer = ""; else configBuffer = "";
        }
    } else if (buffer.length > 2000) {
        // Puffer-Überlauf-Schutz: Falls der Arduino Müll sendet
        if (type === "live") liveBuffer = ""; else configBuffer = "";
    }
}
// --- UI UPDATES ---

// Globaler Cache der letzten Config vom Arduino
let lastConfig = {};

function applyConfig(config) {
    console.log("Konfiguration empfangen:", config);
    configVersion++;

    // Error-Log-Antwort: Nur im Log-View anzeigen
    if (config.errors !== undefined) {
        const logDiv = document.getElementById('log-content');
        let text = `Fehler gesamt: ${config.errorCount || 0}\n\n`;
        if (!config.errors || config.errors.length === 0) {
            text += 'Keine Fehler gespeichert.';
        } else {
            text += config.errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
        }
        logDiv.textContent = text;
        logDiv.scrollTop = logDiv.scrollHeight;
        return;
    }

    // Test-Ergebnis: Nur Messwerte anzeigen, kein volles Config-Update
    if (config.test) {
        testInProgress = false;
        const btn = document.querySelector('#view-sensor-setup button[onclick="testSensor()"]');
        if (btn) { btn.disabled = false; btn.textContent = 'Sensor testen'; }

        const resultDiv = document.getElementById('sc-test-result');
        if (config.error) {
            resultDiv.innerHTML = `<span style="color:#d83b01; font-weight:600;">${escapeHTML(config.error)}</span>`;
        } else if (config.v) {
            let html = '';
            for (const [key, val] of Object.entries(config.v)) {
                html += `<div style="display:flex; justify-content:space-between; padding:4px 0;">
                    <span style="font-weight:500;">${escapeHTML(String(key))}</span>
                    <span style="font-weight:600; color:#0078d4;">${escapeHTML(String(val))}</span>
                </div>`;
            }
            resultDiv.innerHTML = html;
        }
        return;
    }

    lastConfig = config;
    sensorMetadata = config.sensors || [];

    document.getElementById('display-node-name').textContent = config.node_name || "SensorNode";

    // --- Longterm-Felder ---
    document.getElementById('lt-nodename').value = config.node_name || "";
    document.getElementById('lt-project').value = config.project || "";
    document.getElementById('lt-location').value = config.location || "";
    document.getElementById('lt-nodeid').value = config.nodeID || 0;
    document.getElementById('lt-samples').value = config.sampleCount || 1;
    document.getElementById('lt-has-battery').checked = config.has_battery;

    if (config.sleepMs) {
        document.getElementById('lt-sleep').value = Math.round(config.sleepMs / 1000);
    }
    const interval = config.minUpdate !== undefined ? config.minUpdate : config.minUpdateInterval;
    if (interval !== undefined) {
        document.getElementById('lt-minUpdate').value = interval;
    }

    // --- Sensor-Status-Banner ---
    const statusDiv = document.getElementById('sc-sensor-status');
    if (statusDiv) {
        if (config.sensorState === 'active' && sensorMetadata.length > 0) {
            const names = sensorMetadata.filter(s => s.name !== 'Battery').map(s => escapeHTML(s.data)).join(', ');
            statusDiv.innerHTML = `<span style="color:#107c10; font-weight:600;">Sensor aktiv:</span> ${names}`;
            statusDiv.style.background = '#dff6dd';
            statusDiv.style.borderColor = '#107c10';
        } else {
            statusDiv.innerHTML = '<span style="color:#8a6d3b; font-weight:600;">Kein Sensor erkannt.</span> Bitte Sensortyp ausw\u00e4hlen und speichern.';
            statusDiv.style.background = '#fff3cd';
            statusDiv.style.borderColor = '#ffc107';
        }
    }

    // --- Sensor-Config-Felder ---
    const sel = document.getElementById('sc-sensor-type');
    sel.innerHTML = "";
    if (config.sTypes) {
        config.sTypes.forEach(st => {
            const opt = document.createElement('option');
            opt.value = st.id;
            opt.textContent = st.n;
            sel.appendChild(opt);
        });
    }
    sel.value = config.sensorType || 1;
    updateSensorHints(parseInt(sel.value));

    // HMC5883L-specific fields
    if (config.sensorType === 6) {
        document.getElementById('sc-volume-per-pulse').value = config.volumePerPulse || 0.01;
        document.getElementById('sc-pulse-count').value = config.pulseCount || 0;
        const calStatus = document.getElementById('sc-hmc-cal-status');
        if (config.magCalibrated) {
            calStatus.textContent = "Kalibriert (Schwelle: " + (config.magThreshold || 0).toFixed(1) + " µT)";
            calStatus.style.color = "#107c10";
        } else {
            calStatus.textContent = "Nicht kalibriert";
            calStatus.style.color = "#d83b01";
        }
    }

    // DS18B20-specific fields
    if (config.sensorType === 8 && config.ds18b20_probes) {
        renderDS18B20Probes(config.ds18b20_probes);
    }

    // Schwellwert-Felder dynamisch rendern (nur Sensor-Kanäle, ohne Batterie)
    const sensorChannels = sensorMetadata.filter(s => s.name !== "Battery");
    renderThresholdFields(sensorChannels);
    const ltNoSensor = document.getElementById('lt-no-sensor');
    if (ltNoSensor) ltNoSensor.classList.toggle('hidden', sensorChannels.length > 0);

    const badge = document.getElementById('lt-status');
    if (badge) {
        badge.textContent = config.lt_active ? "Langzeitmessung AKTIV" : "Langzeitmessung PAUSE";
        badge.className = "status-badge " + (config.lt_active ? "active" : "inactive");
    }
}

function updateSensorHints(typeId) {
    // SDP810-125Pa = 3, SDP810-Pitot = 4
    document.getElementById('sc-sdp-hint').classList.toggle('hidden', typeId !== 3 && typeId !== 4);
    // ICS-43434 = 7
    document.getElementById('sc-ics-hint').classList.toggle('hidden', typeId !== 7);
    // HMC5883L = 6
    document.getElementById('sc-hmc-config').classList.toggle('hidden', typeId !== 6);
    // DS18B20 = 8
    document.getElementById('sc-ds18b20-config').classList.toggle('hidden', typeId !== 8);
    // SCD40 Test-Hinweis = 2
    document.getElementById('sc-test-hint').classList.toggle('hidden', typeId !== 2);
}

function renderThresholdFields(channels) {
    const container = document.getElementById('lt-threshold-fields');
    container.innerHTML = "";
    channels.forEach(ch => {
        container.innerHTML += `
            <div class="input-group">
                <label>${escapeHTML(ch.data)} – Schwellwert (${escapeHTML(ch.unit)})</label>
                <input type="number" class="thr-input" data-id="${ch.id}"
                       value="${ch.thr}" step="any" min="0">
            </div>`;
    });
}

function updateUI(data) {
    const time = new Date().toLocaleTimeString();
    const values = data.v; // Arduino schickt "v" für values
    if (!values || !sensorMetadata) return;

    // Wir orientieren uns an den Checkboxen, die beim Start der Live-Messung gewählt waren
    const activeIds = Array.from(document.querySelectorAll('.live-sel:checked')).map(el => el.value);

    let row = `<td>${time}</td>`;
    sensorMetadata.forEach(meta => {
        const idStr = meta.id.toString();
        
        if (activeIds.includes(idStr)) {
            const val = values[idStr];
            const numericVal = (val !== undefined) ? parseFloat(val) : null;
            const displayVal = (numericVal !== null) ? numericVal.toFixed(2) : '-';
            
            row += `<td>${displayVal}</td>`;
            
            // Chart Update
            if (charts[meta.id]) {
                const chart = charts[meta.id];
                chart.data.labels.push(time);
                chart.data.datasets[0].data.push(numericVal);
                
                // Rolling Window: Achse wandert nach 40 Werten mit
                if (chart.data.labels.length > 40) {
                    chart.data.labels.shift();
                    chart.data.datasets[0].data.shift();
                }
                chart.update('none'); // Update ohne Animation für Geschwindigkeit
            }
        }
    });

    const tbody = document.getElementById('data-body');
    if (tbody) {
        tbody.insertAdjacentHTML('afterbegin', `<tr>${row}</tr>`);
        if (tbody.rows.length > 100) tbody.deleteRow(100);
    }
}

// --- BEFEHLE (COMMANDS) ---

async function sendLTCommand(cmd) {
    try {
        // UI-Feedback: Zeige an, dass etwas passiert
        const badge = document.getElementById('lt-status');
        if (badge) {
            badge.textContent = "Wird aktualisiert...";
            badge.className = "status-badge"; // Neutrales Styling (grau/weiß)
        }

        configBuffer = ""; // <--- WICHTIG: Puffer komplett leeren vor neuem Befehl

        if (cmd === 'start_lt') {
            const seconds = parseFloat(document.getElementById('lt-sleep').value);

            const newSettings = {
                node_name: document.getElementById('lt-nodename').value,
                project: document.getElementById('lt-project').value,
                location: document.getElementById('lt-location').value,
                nodeID: parseInt(document.getElementById('lt-nodeid').value),
                sleepMs: Math.round(seconds * 1000),
                minUpdateInterval: parseInt(document.getElementById('lt-minUpdate').value),
                sampleCount: parseInt(document.getElementById('lt-samples').value),
                has_battery: document.getElementById('lt-has-battery').checked
            };

            // Schwellwerte mitsenden
            const thrInputs = document.querySelectorAll('#lt-threshold-fields .thr-input');
            if (thrInputs.length > 0) {
                const thresholds = {};
                thrInputs.forEach(inp => { thresholds[inp.dataset.id] = parseFloat(inp.value); });
                newSettings.thresholds = thresholds;
            }

            console.log("Sende Langzeit-Einstellungen:", newSettings);
            await chars.conf.writeValue(new TextEncoder().encode(JSON.stringify(newSettings)));

            // Kurz warten, damit der Arduino das JSON parsen und speichern kann
            await new Promise(r => setTimeout(r, 500));
        }

        // Kommando senden (start_lt oder stop_lt)
        await chars.cmd.writeValue(new TextEncoder().encode(cmd));
        
        // Zurück zur Hauptansicht
        showView('view-main');

        // WICHTIG: Der Timeout-Block der vorher hier war, wurde entfernt!
        // Der Arduino schickt durch "publishConfigJSON()" jetzt ohnehin 
        // eine Benachrichtigung, die in handleData() automatisch die UI aktualisiert.

    } catch (e) { 
        alert("Fehler: " + e.message); 
    }
}

// --- CHARTS ---

function createLiveChart(ctx) {
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{
            data: [],
            borderColor: '#0078d4',
            backgroundColor: 'rgba(0,120,212,0.1)',
            borderWidth: 2, pointRadius: 0, tension: 0.2, fill: true
        }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: {
                x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 5 } },
                y: { beginAtZero: false, grace: '15%', ticks: { font: { size: 10 } } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function initSingleChart(id, canvasId, meta) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (charts[id]) charts[id].destroy();
    charts[id] = createLiveChart(ctx);
}

// --- HELFER & NAVIGATION ---

function resetAppState() {
    liveBuffer = "";
    configBuffer = ""; // WICHTIG: Hier alles leeren
    sensorMetadata = [];
    Object.values(charts).forEach(c => c.destroy());
    charts = {};
    const tbody = document.getElementById('data-body');
    if (tbody) tbody.innerHTML = "";
}

function onDisconnected() {
    console.log("Verbindung verloren.");
    if (dfuInProgress) {
        // Nach Bootloader-Reboot: Seite nicht neu laden, User muss nRF DFU App nutzen
        dfuInProgress = false;
        return;
    }
    location.reload();
}

function disconnectBLE() { 
    if(gatt) gatt.disconnect(); 
}

function showView(id) {
    document.querySelectorAll('.card > div').forEach(div => div.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function renderLiveConfig() {
    const container = document.getElementById('live-sensor-options');
    container.innerHTML = "";

    const noSensorHint = document.getElementById('live-no-sensor');
    if (sensorMetadata.length === 0) {
        if (noSensorHint) noSensorHint.classList.remove('hidden');
    } else {
        if (noSensorHint) noSensorHint.classList.add('hidden');
        // Wir nutzen hier die gleiche 'sensor-row' Klasse wie in den Einstellungen
        sensorMetadata.forEach(s => {
            container.innerHTML += `
                <label class="sensor-row">
                    <input type="checkbox" class="live-sel" value="${s.id}" checked>
                    <span><strong>${escapeHTML(s.data)}</strong> (${escapeHTML(s.name)})</span>
                </label>`;
        });
    }
    showView('view-live-setup');
}

async function openSensorConfig() {
    try {
        showView('view-sensor-setup');
        const statusDiv = document.getElementById('sc-sensor-status');
        if (statusDiv) {
            statusDiv.innerHTML = '<span style="color:#605e5c;">Lade Konfiguration...</span>';
            statusDiv.style.background = '#f3f2f1';
            statusDiv.style.borderColor = '#edebe9';
        }
        configBuffer = "";
        const versionBefore = configVersion;
        await chars.cmd.writeValue(new TextEncoder().encode('ping'));
        // Warte auf Config-Empfang (max 3s)
        let waited = 0;
        while (waited < 3000 && configVersion === versionBefore) {
            await new Promise(r => setTimeout(r, 200));
            waited += 200;
        }
        if (configVersion === versionBefore && statusDiv) {
            statusDiv.innerHTML = '<span style="color:#d83b01; font-weight:600;">Konfiguration konnte nicht geladen werden.</span> BLE-Verbindung pr\u00fcfen.';
            statusDiv.style.background = '#fed9cc';
            statusDiv.style.borderColor = '#d83b01';
        }
    } catch (e) {
        console.error("Fehler beim Öffnen der Sensor-Konfiguration:", e);
        const statusDiv = document.getElementById('sc-sensor-status');
        if (statusDiv) {
            statusDiv.innerHTML = '<span style="color:#d83b01; font-weight:600;">BLE-Verbindungsfehler.</span>';
            statusDiv.style.background = '#fed9cc';
            statusDiv.style.borderColor = '#d83b01';
        }
    }
}

async function saveSensorConfig() {
    try {
        configBuffer = "";

        const sType = parseInt(document.getElementById('sc-sensor-type').value);
        const newSettings = {
            sensorType: sType
        };

        // HMC5883L-specific fields
        if (sType === 6) {
            newSettings.volumePerPulse = parseFloat(document.getElementById('sc-volume-per-pulse').value);
            newSettings.pulseCount = parseInt(document.getElementById('sc-pulse-count').value);
        }
        // DS18B20 probe labels
        if (sType === 8) {
            const probes = [];
            document.querySelectorAll('.ds-probe-row').forEach(row => {
                probes.push({
                    addr: row.dataset.addr,
                    label: row.querySelector('.ds-label').value || 'Probe'
                });
            });
            if (probes.length > 0) newSettings.ds18b20_probes = probes;
        }

        const statusDiv = document.getElementById('sc-sensor-status');
        if (statusDiv) {
            statusDiv.innerHTML = '<span style="color:#605e5c;">Wird gespeichert...</span>';
            statusDiv.style.background = '#f3f2f1';
            statusDiv.style.borderColor = '#edebe9';
        }

        console.log("Sende Sensor-Konfiguration:", newSettings);
        try {
            await chars.conf.writeValue(new TextEncoder().encode(JSON.stringify(newSettings)));
        } catch (writeErr) {
            throw new Error("Konfiguration konnte nicht gesendet werden: " + writeErr.message);
        }
        await new Promise(r => setTimeout(r, 500));
        try {
            await chars.cmd.writeValue(new TextEncoder().encode('save'));
        } catch (writeErr) {
            throw new Error("Speicher-Befehl fehlgeschlagen: " + writeErr.message);
        }

        // Config neu laden, damit sensorMetadata (Kanäle/Schwellwerte) aktualisiert wird
        await new Promise(r => setTimeout(r, 500));
        configBuffer = "";
        const vBefore = configVersion;
        await chars.cmd.writeValue(new TextEncoder().encode('ping'));
        let w = 0;
        while (w < 2000 && configVersion === vBefore) {
            await new Promise(r => setTimeout(r, 200));
            w += 200;
        }
        if (configVersion === vBefore) {
            console.warn("Config-Bestätigung nicht empfangen (Timeout)");
        }

        showView('view-main');
    } catch (e) {
        alert("Fehler: " + e.message);
    }
}

async function openLongtermConfig() {
    try {
        console.log("Fordere aktuelles Setup via Notification an...");
        
        // Puffer leeren, bevor wir den Ping senden
        configBuffer = ""; 
        
        // Ein Dummy-Kommando senden. Der Arduino ignoriert den Text, 
        // antwortet aber immer mit publishConfigJSON()!
        await chars.cmd.writeValue(new TextEncoder().encode('ping'));
        
        // Eine halbe Sekunde warten, bis die Benachrichtigung da und geparst ist,
        // dann die Ansicht wechseln.
        setTimeout(() => {
            showView('view-longterm-setup');
        }, 500);

    } catch (e) {
        console.error("Fehler beim Öffnen der Konfiguration:", e);
        showView('view-longterm-setup');
    }
}

async function startLive(mode) {
    const selectedIds = Array.from(document.querySelectorAll('.live-sel:checked')).map(el => parseInt(el.value));
    if(selectedIds.length === 0) return alert("Bitte wähle mindestens einen Sensor!");

    const chartContainer = document.getElementById('dynamic-charts');
    const tableHead = document.getElementById('table-head');
    
    chartContainer.innerHTML = "";
    tableHead.innerHTML = "<th>Zeit</th>";
    document.getElementById('data-body').innerHTML = "";
    charts = {};

    selectedIds.forEach(id => {
        const meta = sensorMetadata.find(m => m.id === id);
        tableHead.innerHTML += `<th>${escapeHTML(meta.data)} [${escapeHTML(meta.unit)}]</th>`;
        
        if (mode === 'chart') {
            const canvasId = `chart-${id}`;
            chartContainer.innerHTML += `
                <div class="chart-card">
                    <small>${escapeHTML(meta.data)} (${escapeHTML(meta.unit)})</small>
                    <div style="height:120px"><canvas id="${canvasId}"></canvas></div>
                </div>`;
            setTimeout(() => initSingleChart(id, canvasId, meta), 100);
        }
    });

    document.getElementById('container-table').classList.toggle('hidden', mode === 'chart');
    document.getElementById('export-controls-chart').classList.toggle('hidden', mode !== 'chart');
    document.getElementById('export-controls-table').classList.toggle('hidden', mode === 'chart');
    
    // Befehle an Arduino senden
    const rateVal = parseFloat(document.getElementById('live-interval').value);
    const rateMs = Math.round(rateVal * 1000);
    
    await chars.sens.writeValue(new TextEncoder().encode(selectedIds.join(',')));
    await chars.rate.writeValue(new Uint32Array([rateMs]));
    await chars.mode.writeValue(new TextEncoder().encode('live'));
    
    showView('view-data');
}

async function stopLive() {
    try {
        // 1. WICHTIG: Puffer leeren, damit Fragmente keinen unsichtbaren Fehler werfen
        liveBuffer = "";
        configBuffer = "";

        // 2. Arduino den Befehl zum Beenden senden
        await chars.cmd.writeValue(new TextEncoder().encode('back'));
        
        // 3. Ansicht wechseln
        setTimeout(() => showView('view-main'), 200);
    } catch (e) {
        console.error("Fehler beim Beenden der Live-Messung:", e);
    }
}

// --- EXPORT FUNKTIONEN ---

function downloadCSV() {
    const activeIds = Array.from(document.querySelectorAll('.live-sel:checked')).map(el => parseInt(el.value));
    const activeMeta = sensorMetadata.filter(m => activeIds.includes(m.id));
    if (activeMeta.length === 0 || !charts[activeMeta[0].id]) return alert("Keine Daten zum Exportieren!");

    // Kopfzeile erstellen
    let csv = "Zeit;";
    activeMeta.forEach(m => csv += `${m.data} [${m.unit}];`);
    csv += "\r\n";

    // Datenreihen aus dem ersten Graphen als Zeit-Referenz auslesen
    const labels = charts[activeMeta[0].id].data.labels;
    for (let i = 0; i < labels.length; i++) {
        csv += `${labels[i]};`;
        activeMeta.forEach(m => {
            // Deutsches Zahlenformat (Komma statt Punkt) für Excel-Kompatibilität
            let val = charts[m.id].data.datasets[0].data[i];
            csv += `${val !== null ? val.toString().replace('.', ',') : ''};`;
        });
        csv += "\r\n";
    }

    // Download triggern
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Live_Messung_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function downloadCharts() {
    const activeIds = Array.from(document.querySelectorAll('.live-sel:checked')).map(el => parseInt(el.value));
    if (activeIds.length === 0) return alert("Keine Graphen zum Exportieren!");

    activeIds.forEach(id => {
        if (charts[id]) {
            const a = document.createElement('a');
            // Zieht sich das Bild direkt aus dem Canvas
            a.href = charts[id].toBase64Image(); 
            const meta = sensorMetadata.find(m => m.id === id);
            a.download = `Graph_${meta ? meta.data : id}.png`;
            a.click();
        }
    });
}

function downloadTableCSV() {
    let csv = "";
    
    // 1. Kopfzeile (Headers) auslesen
    const ths = document.querySelectorAll('#table-head th');
    if (ths.length === 0 || ths[0].innerText === "") {
        return alert("Keine Tabellendaten zum Exportieren vorhanden!");
    }
    
    let headers = [];
    ths.forEach(th => headers.push(th.innerText));
    csv += headers.join(";") + "\r\n";
    
    // 2. Datenzeilen (Rows) auslesen
    const trs = document.querySelectorAll('#data-body tr');
    trs.forEach(tr => {
        let rowData = [];
        tr.querySelectorAll('td').forEach(td => {
            // Deutsches Zahlenformat für Excel (Punkt zu Komma machen)
            let val = td.innerText.replace('.', ',');
            rowData.push(val);
        });
        csv += rowData.join(";") + "\r\n";
    });
    
    // 3. Download triggern
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Live_Tabelle_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- DS18B20 ---
async function scanDS18B20() {
    try {
        const list = document.getElementById('sc-ds-probe-list');
        list.innerHTML = '<p style="color:#605e5c;">Suche Sensoren...</p>';
        configBuffer = "";
        await chars.cmd.writeValue(new TextEncoder().encode('ds_scan'));
        // Results come back via config push (applyConfig → renderDS18B20Probes)
    } catch (e) {
        alert("Fehler: " + e.message);
    }
}

function renderDS18B20Probes(probes) {
    const list = document.getElementById('sc-ds-probe-list');
    list.innerHTML = '';
    if (!probes || probes.length === 0) {
        list.innerHTML = '<p style="color:#d83b01;">Keine Sensoren gefunden. Kabel prüfen und erneut scannen.</p>';
        return;
    }
    probes.forEach((p, i) => {
        const shortAddr = p.addr ? p.addr.substring(0, 4) + '...' + p.addr.substring(12) : '?';
        const tempStr = (p.temp !== undefined && p.temp !== null) ? parseFloat(p.temp).toFixed(1) + ' °C' : '–';
        list.innerHTML += `
            <div class="ds-probe-row" data-addr="${escapeHTML(p.addr)}" style="background:#f8f9fa; border:1px solid #edebe9; border-radius:8px; padding:12px 15px; margin-bottom:10px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="font-size:0.85em; color:#605e5c;">Sensor ${i+1} (${escapeHTML(shortAddr)})</span>
                    <span style="font-size:0.9em; font-weight:600; color:#0078d4;">${escapeHTML(tempStr)}</span>
                </div>
                <input type="text" class="ds-label" value="${escapeHTML(p.label || '')}" maxlength="15" placeholder="z.B. Vorlauf HK1" style="margin-bottom:0;">
            </div>`;
    });
}

// --- SENSOR TEST ---
let testInProgress = false;

async function testSensor() {
    if (testInProgress) return;
    try {
        testInProgress = true;
        const btn = document.querySelector('#view-sensor-setup button[onclick="testSensor()"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Konfiguration wird geladen...'; }

        const resultDiv = document.getElementById('sc-test-result');
        resultDiv.innerHTML = '<span style="color:#605e5c;">Sensor wird konfiguriert...</span>';

        // 1. Sensor-Config an Firmware senden (Typ, Schwellwerte, etc.)
        const sType = parseInt(document.getElementById('sc-sensor-type').value);
        const testConfig = { sensorType: sType };
        if (sType === 6) {
            testConfig.volumePerPulse = parseFloat(document.getElementById('sc-volume-per-pulse').value);
            testConfig.pulseCount = parseInt(document.getElementById('sc-pulse-count').value);
        }
        if (sType === 8) {
            const probes = [];
            document.querySelectorAll('.ds-probe-row').forEach(row => {
                probes.push({ addr: row.dataset.addr, label: row.querySelector('.ds-label').value || 'Probe' });
            });
            if (probes.length > 0) testConfig.ds18b20_probes = probes;
        }
        configBuffer = "";
        await chars.conf.writeValue(new TextEncoder().encode(JSON.stringify(testConfig)));
        await new Promise(r => setTimeout(r, 500));

        // 2. Test starten
        if (btn) btn.textContent = 'Wird vorbereitet...';
        resultDiv.innerHTML = '<span style="color:#605e5c;">Sensor wird vorbereitet...</span>';
        await chars.cmd.writeValue(new TextEncoder().encode('test'));
        // Ergebnis kommt via configChar → applyConfig erkennt "test" Feld
        // Timeout: Falls nach 45s keine Antwort kommt
        setTimeout(() => {
            if (testInProgress) {
                testInProgress = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Sensor testen'; }
                resultDiv.innerHTML = '<span style="color:#d83b01; font-weight:600;">Sensor-Test fehlgeschlagen (Timeout)</span>'
                    + '<div style="margin-top:8px; font-size:0.9em; color:#605e5c;">'
                    + '\u2022 Sensor richtig angeschlossen? (Kabel pr\u00fcfen)<br>'
                    + '\u2022 Richtigen Sensortyp ausgew\u00e4hlt?<br>'
                    + '\u2022 Bei SCD40/SCD41: 30s Aufw\u00e4rmzeit abwarten</div>';
            }
        }, 45000);
    } catch (e) {
        testInProgress = false;
        const btn = document.querySelector('#view-sensor-setup button[onclick="testSensor()"]');
        if (btn) { btn.disabled = false; btn.textContent = 'Sensor testen'; }
        alert("Fehler: " + e.message);
    }
}

// --- KALIBRIERUNG ---
async function sendCalibrate() {
    try {
        const calStatus = document.getElementById('sc-hmc-cal-status');
        calStatus.textContent = "Kalibrierung läuft...";
        calStatus.style.color = "#605e5c";

        configBuffer = "";
        await chars.cmd.writeValue(new TextEncoder().encode('calibrate'));

        // Wait for cal_ok/cal_fail status (comes via statusChar or config push)
        // Config push will update UI via applyConfig
    } catch (e) {
        alert("Fehler: " + e.message);
    }
}

// --- ERROR LOG ---
async function openLog() {
    try {
        const logDiv = document.getElementById('log-content');
        logDiv.textContent = 'Lade Error-Log...';
        showView('view-log');
        // Kurz warten damit evtl. laufender Config-Push durchkommt
        await new Promise(r => setTimeout(r, 300));
        configBuffer = "";
        await chars.cmd.writeValue(new TextEncoder().encode('get_log'));
        // Timeout: Falls nach 4s nichts kommt, Hinweis anzeigen
        setTimeout(() => {
            if (logDiv.textContent === 'Lade Error-Log...') {
                logDiv.textContent = 'Keine Antwort vom Sensor. Bitte erneut versuchen.';
            }
        }, 4000);
    } catch (e) {
        console.error("Fehler beim Laden des Error-Logs:", e);
        document.getElementById('log-content').textContent = 'Fehler: ' + e.message;
    }
}

// --- FIRMWARE UPDATE (DFU) ---
function openDfu() {
    document.getElementById('dfu-status').textContent = '';
    document.getElementById('dfu-buttons').classList.remove('hidden');
    showView('view-dfu');
}

async function rebootToBootloader() {
    if (!confirm('Node in Bootloader-Modus starten? Danach mit der nRF DFU App verbinden.')) return;

    const statusEl = document.getElementById('dfu-status');
    dfuInProgress = true;

    try {
        statusEl.textContent = 'Sende Bootloader-Befehl...';
        await chars.cmd.writeValue(new TextEncoder().encode('dfu'));
        statusEl.textContent = 'Node startet Bootloader. Jetzt nRF DFU App öffnen.';
        statusEl.style.color = 'var(--success)';
        document.getElementById('dfu-buttons').classList.add('hidden');
        // "Neu verbinden"-Button anzeigen damit User zurück zur App kann
        const reconnBtn = document.createElement('button');
        reconnBtn.textContent = 'Neu verbinden';
        reconnBtn.style.marginTop = '1rem';
        reconnBtn.onclick = () => location.reload();
        statusEl.parentNode.appendChild(reconnBtn);
    } catch (e) {
        dfuInProgress = false;
        statusEl.textContent = 'Fehler: ' + e.message;
        statusEl.style.color = 'var(--danger)';
    }
}

// --- EVENT LISTENER ---
document.getElementById('sc-sensor-type').addEventListener('change', function() {
    updateSensorHints(parseInt(this.value));
});