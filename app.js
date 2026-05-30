'use strict';

// ═══════════════════════════════════════════════
//  DB — IndexedDB via a tiny wrapper
// ═══════════════════════════════════════════════
const DB_NAME = 'pantry-db';
const DB_VER  = 1;
let db;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('items')) {
        const store = d.createObjectStore('items', { keyPath: 'id' });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('expiry',   'expiry',   { unique: false });
      }
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = () => rej(req.error);
  });
}

function dbAll() {
  return new Promise((res, rej) => {
    const tx = db.transaction('items', 'readonly');
    const req = tx.objectStore('items').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(item) {
  return new Promise((res, rej) => {
    const tx = db.transaction('items', 'readwrite');
    const req = tx.objectStore('items').put(item);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function dbDelete(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction('items', 'readwrite');
    const req = tx.objectStore('items').delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ═══════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════
let items       = [];
let activeTab   = 'pantry';
let searchQuery = '';

// Scan wizard state
let scanStep    = 1; // 1=barcode, 2=date, 3=confirm
let scanData    = {};
let videoStream = null;
let barcodeWorker = null; // ZXing-style polling interval

// ═══════════════════════════════════════════════
//  Date helpers
// ═══════════════════════════════════════════════
function today()     { return new Date().toISOString().split('T')[0]; }
function daysUntil(dateStr) {
  const now = new Date(); now.setHours(0,0,0,0);
  const exp = new Date(dateStr + 'T00:00:00');
  return Math.round((exp - now) / 86400000);
}
function expiryClass(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0)  return 'expired';
  if (d <= 3) return 'warn';
  return 'ok';
}
// Format a YYYY-MM-DD string as DD/MM/YYYY for display
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, dd] = dateStr.split('-');
  return `${dd}/${m}/${y}`;
}

function expiryLabel(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0)  return `Expired ${Math.abs(d)}d ago`;
  if (d === 0) return 'Expires today!';
  if (d === 1) return 'Expires tomorrow';
  if (d <= 3) return `Expires in ${d} days`;
  return `Best before ${fmtDate(dateStr)}`;
}

// ═══════════════════════════════════════════════
//  Category icons
// ═══════════════════════════════════════════════
const CAT_ICONS = { fridge:'🧊', freezer:'❄️', cupboard:'🗄️', other:'📦' };
const CATEGORIES = ['fridge','freezer','cupboard','other'];

// ═══════════════════════════════════════════════
//  Render
// ═══════════════════════════════════════════════
function render() {
  const el = document.getElementById('main-content');
  let filtered = items.filter(i => !i.removed);

  // Tab filter
  if (activeTab === 'expiring') {
    filtered = filtered.filter(i => { const d = daysUntil(i.expiry); return d >= 0 && d <= 3; });
  } else if (activeTab === 'expired') {
    filtered = filtered.filter(i => daysUntil(i.expiry) < 0);
  }

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(i => i.name.toLowerCase().includes(q) || i.barcode.includes(q));
  }

  // Update expiring tab badge
  const expiringCount = items.filter(i => !i.removed && daysUntil(i.expiry) >= 0 && daysUntil(i.expiry) <= 3).length;
  const expiredCount  = items.filter(i => !i.removed && daysUntil(i.expiry) < 0).length;
  document.querySelectorAll('nav button')[1].querySelector('.nav-icon').textContent = expiringCount ? `⏰` : '⏰';
  document.querySelectorAll('nav button')[2].querySelector('.nav-icon').textContent = expiredCount  ? `🚨` : '🚨';

  if (filtered.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-icon">${activeTab==='expired'?'✅':activeTab==='expiring'?'🎉':'🥫'}</div>
        <p>${
          activeTab==='expired'  ? 'No expired items. Nice!' :
          activeTab==='expiring' ? 'Nothing expiring soon.' :
          'Your pantry is empty.<br>Tap <strong>Scan Item</strong> to add something.'
        }</p>
      </div>`;
    return;
  }

  // Group by category
  const groups = {};
  for (const cat of CATEGORIES) groups[cat] = [];
  for (const item of filtered) (groups[item.category] || (groups['other'] = groups['other'] || [])).push(item) && 0 || groups[item.category]?.push(item) || groups['other'].push(item);

  // rebuild groups properly
  const grouped = {};
  for (const cat of CATEGORIES) grouped[cat] = [];
  for (const item of filtered) {
    const c = CATEGORIES.includes(item.category) ? item.category : 'other';
    grouped[c].push(item);
  }

  let html = '';
  for (const cat of CATEGORIES) {
    const g = grouped[cat];
    if (!g.length) continue;
    // Sort: expired first, then by date ascending
    g.sort((a,b) => new Date(a.expiry) - new Date(b.expiry));
    html += `<div class="category-group">
      <div class="category-header">${CAT_ICONS[cat]} ${cat}</div>`;
    for (const item of g) {
      const ec = expiryClass(item.expiry);
      html += `
        <div class="item-card ${ec}" data-id="${item.id}">
          <div class="item-info">
            <div class="item-name">${esc(item.name)}</div>
            <div class="item-meta">
              <span class="item-date ${ec}">${expiryLabel(item.expiry)}</span>
              <span class="item-barcode">${esc(item.barcode)}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="btn-icon" onclick="openDetail('${item.id}')" title="Details">ℹ️</button>
            <button class="btn-icon" onclick="markRemoved('${item.id}')" title="Used / thrown away">✅</button>
          </div>
        </div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════
//  Item actions
// ═══════════════════════════════════════════════
async function markRemoved(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  item.removed = true;
  await dbPut(item);
  await loadItems();
  render();
}

function openDetail(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  const ec = expiryClass(item.expiry);
  const d  = document.getElementById('detail-body');
  d.innerHTML = `
    <h2 style="font-family:var(--font-head);font-size:1.4rem;margin-bottom:4px">${esc(item.name)}</h2>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:20px">Added ${fmtDate(item.added)}</p>
    ${ec==='expired' ? `<div class="expired-banner">⚠️ This item has expired and should be discarded.</div>` : ''}
    <div class="result-pill">
      <span class="pill-icon">📅</span>
      <div><div class="pill-label">Best before / Use by</div>
      <div class="pill-value" style="color:${ec==='expired'?'#e07070':ec==='warn'?'#f0a050':'#4caf7d'}">${expiryLabel(item.expiry)}</div></div>
    </div>
    <div class="result-pill">
      <span class="pill-icon">${CAT_ICONS[item.category]||'📦'}</span>
      <div><div class="pill-label">Stored in</div>
      <div class="pill-value" style="text-transform:capitalize">${esc(item.category)}</div></div>
    </div>
    <div class="result-pill">
      <span class="pill-icon">🔢</span>
      <div><div class="pill-label">Barcode</div>
      <div class="pill-value" style="font-family:monospace;font-size:0.9rem">${esc(item.barcode)}</div></div>
    </div>
    <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
      <button class="btn btn-primary" onclick="markRemoved('${item.id}');closeDetail()">✅ Mark as used / thrown away</button>
      <button class="btn btn-danger" onclick="deleteItem('${item.id}');closeDetail()">🗑️ Delete from pantry</button>
      <button class="btn btn-secondary" onclick="closeDetail()">Close</button>
    </div>`;
  openModal('detail-modal');
}

function closeDetail() { closeModal('detail-modal'); }

async function deleteItem(id) {
  await dbDelete(id);
  await loadItems();
  render();
}

// ═══════════════════════════════════════════════
//  Modal helpers
// ═══════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  if (id === 'scan-modal') stopCamera();
}

// ═══════════════════════════════════════════════
//  Camera
// ═══════════════════════════════════════════════
async function startCamera(videoEl) {
  stopCamera();
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    videoEl.srcObject = videoStream;
    await videoEl.play();
    return true;
  } catch(e) {
    console.error('Camera error', e);
    return false;
  }
}

function stopCamera() {
  if (barcodeWorker) { clearInterval(barcodeWorker); barcodeWorker = null; }
  if (videoStream)   { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
}

function captureFrame(videoEl) {
  const canvas = document.createElement('canvas');
  canvas.width  = videoEl.videoWidth  || 640;
  canvas.height = videoEl.videoHeight || 480;
  canvas.getContext('2d').drawImage(videoEl, 0, 0);
  return canvas;
}

// ═══════════════════════════════════════════════
//  Barcode detection
//  — Native BarcodeDetector (Chrome/Android) first
//  — ZXing fallback (Safari, Firefox, everything else)
// ═══════════════════════════════════════════════

// We reuse one ZXing reader instance rather than creating a new one every frame
let _zxingReader = null;
function getZXingReader() {
  if (!_zxingReader && window.ZXingBrowser) {
    try { _zxingReader = new ZXingBrowser.BrowserMultiFormatReader(); } catch(e) {}
  }
  return _zxingReader;
}

async function detectBarcode(canvas) {
  // ── Option 1: Native BarcodeDetector (Chrome Android, Chrome desktop) ──
  if ('BarcodeDetector' in window) {
    try {
      const bd = new BarcodeDetector();
      const results = await bd.detect(canvas);
      if (results.length > 0) return results[0].rawValue;
    } catch(e) {}
  }

  // ── Option 2: ZXing (Safari, Firefox, everything else) ──
  // ZXing works by decoding an <img> element, so we convert the canvas to a data URL
  const reader = getZXingReader();
  if (reader) {
    try {
      const img = new Image();
      img.src = canvas.toDataURL('image/png');
      await new Promise(r => { img.onload = r; });
      const result = await reader.decodeFromImageElement(img);
      if (result) return result.getText();
    } catch(e) {
      // ZXing throws a NotFoundException when nothing is found — that's normal, not a real error
    }
  }

  return null;
}

// ═══════════════════════════════════════════════
//  Product lookup (Open Food Facts)
// ═══════════════════════════════════════════════
async function lookupBarcode(barcode) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
    const j = await r.json();
    if (j.status === 1) {
      return j.product.product_name || j.product.product_name_en || null;
    }
  } catch(e) {}
  return null;
}

// ═══════════════════════════════════════════════
//  OCR date reading with Tesseract
// ═══════════════════════════════════════════════
async function ocrDate(canvas) {
  try {
    const worker = await Tesseract.createWorker('eng');
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789/-.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
    });
    const { data: { text } } = await worker.recognize(canvas);
    await worker.terminate();
    return parseDate(text);
  } catch(e) {
    console.error('OCR error', e);
    return null;
  }
}

function parseDate(text) {
  // Common patterns: 12/2026, 12/26, 31/12/26, 31/12/2026, 2026-12-31, Dec 2026, JAN 26
  const t = text.replace(/\n/g,' ').toUpperCase();

  // YYYY-MM-DD
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy4 = t.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (dmy4) return `${dmy4[3]}-${dmy4[2].padStart(2,'0')}-${dmy4[1].padStart(2,'0')}`;

  // DD/MM/YY
  const dmy2 = t.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})/);
  if (dmy2) {
    const yr = parseInt(dmy2[3]) > 50 ? '19'+dmy2[3] : '20'+dmy2[3];
    return `${yr}-${dmy2[2].padStart(2,'0')}-${dmy2[1].padStart(2,'0')}`;
  }

  // MM/YYYY (end of month)
  const mmy = t.match(/(\d{1,2})[\/\-\.](\d{4})/);
  if (mmy) {
    const lastDay = new Date(parseInt(mmy[2]), parseInt(mmy[1]), 0).getDate();
    return `${mmy[2]}-${mmy[1].padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  }

  // Month name: JAN 2026, JAN 26, JANUARY 2026
  const months = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
  for (const [name, num] of Object.entries(months)) {
    const re = new RegExp(name + '[A-Z]*\\s*(\\d{2,4})');
    const m  = t.match(re);
    if (m) {
      const yr = m[1].length === 2 ? '20'+m[1] : m[1];
      const lastDay = new Date(parseInt(yr), num, 0).getDate();
      return `${yr}-${String(num).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════
//  Scan wizard
// ═══════════════════════════════════════════════
function updateSteps(current) {
  for (let i=1; i<=3; i++) {
    const el = document.getElementById(`step-${i}`);
    if (i < current)  { el.className = 'step done'; }
    else if (i===current) { el.className = 'step active'; }
    else              { el.className = 'step'; }
  }
}

function setSubtitle(text) {
  document.getElementById('modal-subtitle').textContent = text;
}

// ── Step 1: Barcode scan ──
async function showStep1() {
  scanStep = 1;
  updateSteps(1);
  setSubtitle('Step 1 of 3 — Scan the barcode');
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <div class="viewfinder-wrap">
      <video id="scan-video" playsinline muted autoplay></video>
      <div class="scan-overlay"><div class="scan-box"></div></div>
      <div class="scan-hint">Centre the barcode in the box</div>
    </div>
    <div class="ocr-status" id="scan-status">
      <span>📷</span> <span>Starting camera…</span>
    </div>
    <div class="field">
      <label>Or enter barcode manually</label>
      <input type="text" id="manual-barcode" placeholder="e.g. 5012345678900" inputmode="numeric" />
    </div>
    <button class="btn btn-secondary" id="btn-manual-barcode">Continue with manual barcode</button>
    <button class="btn btn-secondary" onclick="closeModal('scan-modal')" style="margin-top:8px">Cancel</button>`;

  const video = document.getElementById('scan-video');
  const ok = await startCamera(video);
  const status = document.getElementById('scan-status');

  if (!ok) {
    status.innerHTML = `<span>⚠️</span> <span>Camera not available. Enter barcode manually below.</span>`;
  } else {
    status.innerHTML = `<span class="spinner">⏳</span> <span>Scanning for barcode…</span>`;
    // Poll for barcode
    barcodeWorker = setInterval(async () => {
      if (!videoStream) return;
      const canvas = captureFrame(video);
      const code   = await detectBarcode(canvas);
      if (code) {
        clearInterval(barcodeWorker); barcodeWorker = null;
        await onBarcodeFound(code);
      }
    }, 400);
  }

  document.getElementById('btn-manual-barcode').onclick = () => {
    const val = document.getElementById('manual-barcode').value.trim();
    if (val) onBarcodeFound(val);
  };
}

async function onBarcodeFound(code) {
  stopCamera();
  scanData.barcode = code;
  const status = document.getElementById('scan-status');
  if (status) status.innerHTML = `<span>🔍</span> <span>Looking up product…</span>`;
  const name = await lookupBarcode(code);
  scanData.name = name || '';
  showStep2();
}

// ── Step 2: Date scan ──
async function showStep2() {
  scanStep = 2;
  updateSteps(2);
  setSubtitle('Step 2 of 3 — Scan the use-by date');
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <div class="result-pill">
      <span class="pill-icon">🔢</span>
      <div><div class="pill-label">Barcode found</div>
      <div class="pill-value" style="font-family:monospace">${esc(scanData.barcode)}</div></div>
    </div>
    <div class="viewfinder-wrap">
      <video id="scan-video2" playsinline muted autoplay></video>
      <div class="scan-overlay"><div class="scan-box-date"></div></div>
      <div class="scan-hint">Hold the date flat and in good light</div>
    </div>
    <div class="ocr-status" id="ocr-status">
      <span>📷</span> <span>Starting camera…</span>
    </div>
    <button class="btn btn-primary" id="btn-capture-date" disabled>📸 Capture & Read Date</button>
    <div class="field" style="margin-top:14px">
      <label>Or enter date manually</label>
      <input type="date" id="manual-date" min="${today()}" />
    </div>
    <button class="btn btn-secondary" id="btn-manual-date">Continue with manual date</button>
    <button class="btn btn-secondary" onclick="showStep1()" style="margin-top:8px">← Back</button>`;

  const video2   = document.getElementById('scan-video2');
  const ocrSt    = document.getElementById('ocr-status');
  const captBtn  = document.getElementById('btn-capture-date');

  const ok = await startCamera(video2);
  if (!ok) {
    ocrSt.innerHTML = `<span>⚠️</span> <span>Camera unavailable. Enter date manually.</span>`;
  } else {
    ocrSt.innerHTML = `<span>📷</span> <span>Camera ready. Frame the date and tap Capture.</span>`;
    captBtn.disabled = false;
  }

  captBtn.onclick = async () => {
    captBtn.disabled = true;
    captBtn.textContent = '⏳ Reading date…';
    ocrSt.innerHTML = `<span class="spinner">⏳</span> <span>Running OCR — this may take a few seconds…</span>`;
    const canvas = captureFrame(video2);
    stopCamera();
    const parsed = await ocrDate(canvas);
    if (parsed) {
      ocrSt.innerHTML = `<span>✅</span> <span>Date read: <strong>${parsed}</strong> — check it below</span>`;
      const md = document.getElementById('manual-date');
      if (md) md.value = parsed;
    } else {
      ocrSt.innerHTML = `<span>⚠️</span> <span>Couldn't read date clearly. Please enter it manually.</span>`;
    }
    captBtn.textContent = '📸 Capture again';
    captBtn.disabled = false;
    if (!videoStream) {
      const ok2 = await startCamera(video2);
      if (ok2) captBtn.disabled = false;
    }
  };

  document.getElementById('btn-manual-date').onclick = () => {
    const val = document.getElementById('manual-date').value;
    if (val) onDateFound(val);
  };
}

function onDateFound(date) {
  stopCamera();
  scanData.expiry = date;
  showStep3();
}

// ── Step 3: Confirm & categorise ──
function showStep3() {
  scanStep = 3;
  updateSteps(3);
  setSubtitle('Step 3 of 3 — Confirm details');
  const body = document.getElementById('modal-body');
  body.innerHTML = `
    <div class="field">
      <label>Product name</label>
      <input type="text" id="confirm-name" value="${esc(scanData.name)}" placeholder="e.g. Oat milk" />
    </div>
    <div class="field">
      <label>Barcode</label>
      <input type="text" id="confirm-barcode" value="${esc(scanData.barcode)}" readonly style="opacity:0.6" />
    </div>
    <div class="field">
      <label>Use-by / Best before</label>
      <input type="date" id="confirm-date" value="${esc(scanData.expiry||today())}" />
    </div>
    <div class="field">
      <label>Stored in</label>
      <select id="confirm-cat">
        ${CATEGORIES.map(c=>`<option value="${c}" ${c==='cupboard'?'selected':''}>${CAT_ICONS[c]} ${c.charAt(0).toUpperCase()+c.slice(1)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-primary" id="btn-save-item">✅ Add to Pantry</button>
    <button class="btn btn-secondary" onclick="showStep2()" style="margin-top:8px">← Back</button>`;

  document.getElementById('btn-save-item').onclick = saveItem;
}

async function saveItem() {
  const name   = document.getElementById('confirm-name').value.trim();
  const barcode= document.getElementById('confirm-barcode').value.trim();
  const expiry = document.getElementById('confirm-date').value;
  const cat    = document.getElementById('confirm-cat').value;
  if (!name || !expiry) { alert('Please fill in the name and date.'); return; }

  const item = {
    id:       crypto.randomUUID(),
    name, barcode, expiry, category: cat,
    added:    today(),
    removed:  false
  };
  await dbPut(item);
  await loadItems();
  render();
  closeModal('scan-modal');
}

// ═══════════════════════════════════════════════
//  Load items
// ═══════════════════════════════════════════════
async function loadItems() {
  items = await dbAll();
}

// ═══════════════════════════════════════════════
//  Google Drive Sync
//  ─ Uses Google Identity Services (OAuth 2.0)
//  ─ Saves pantry data as a single JSON file
//    called "pantry-tracker-backup.json" in the
//    user's Drive app data folder (hidden from
//    their main Drive view, only this app sees it)
// ═══════════════════════════════════════════════

// !! REPLACE THIS with your own Client ID from Google Cloud Console !!
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID_HERE';

const DRIVE_SCOPE    = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILENAME = 'pantry-tracker-backup.json';

let driveToken     = null;  // current OAuth access token
let driveTokenExp  = 0;     // when it expires (epoch ms)
let driveFileId    = null;  // cached file ID once we've found/created the file

// ── Status indicator ──
function setDriveStatus(state, text) {
  const dot    = document.getElementById('drive-dot');
  const label  = document.getElementById('drive-status-text');
  const status = document.getElementById('drive-status');
  if (!dot) return;
  status.style.display = 'flex';
  dot.className = `drive-dot ${state}`;
  label.textContent = text;
}

// ── Wait for Google Identity Services to load ──
function waitForGoogle(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(check); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(check); reject(new Error('Google script timed out — check your internet connection')); }
    }, 100);
  });
}

// ── Get a valid token (interactive = show Google sign-in popup) ──
function getDriveToken(interactive = false) {
  return new Promise(async (resolve, reject) => {
    // If we have a token that's still valid (with 60s buffer), reuse it
    if (driveToken && Date.now() < driveTokenExp - 60000) {
      return resolve(driveToken);
    }
    try {
      await waitForGoogle();
    } catch(e) {
      return reject(e);
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error === 'access_denied' ? 'Permission denied — please allow access to continue' : resp.error));
        driveToken    = resp.access_token;
        driveTokenExp = Date.now() + (resp.expires_in * 1000);
        resolve(driveToken);
      },
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in popup was closed' : (e.message || 'Sign-in failed'))),
    });
    client.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

// ── Find the backup file in appDataFolder ──
async function findDriveFile(token) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%27${DRIVE_FILENAME}%27&fields=files(id,name,modifiedTime)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const j = await r.json();
  return j.files?.[0] || null;
}

// ── Upload (create or update) the backup file ──
async function uploadToDrive(token, data) {
  const body     = JSON.stringify(data);
  const blob     = new Blob([body], { type: 'application/json' });
  const metadata = { name: DRIVE_FILENAME, parents: driveFileId ? undefined : ['appDataFolder'] };

  let url, method;
  if (driveFileId) {
    // Update existing file
    url    = `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`;
    method = 'PATCH';
  } else {
    // Create new file
    url    = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    method = 'POST';
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const j = await r.json();
  if (j.id) driveFileId = j.id;
  return j;
}

// ── Download the backup file ──
async function downloadFromDrive(token, fileId) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return await r.json();
}

// ── Public: back up to Drive ──
async function backupToDrive() {
  setDriveStatus('syncing', 'Saving…');
  try {
    const token   = await getDriveToken(true);
    const allItems = await dbAll();
    await uploadToDrive(token, { version: 1, exportedAt: new Date().toISOString(), items: allItems });
    setDriveStatus('connected', 'Saved ✓');
    return { ok: true };
  } catch(e) {
    console.error('Drive backup failed', e);
    setDriveStatus('error', 'Error');
    return { ok: false, error: e.message };
  }
}

// ── Public: restore from Drive ──
async function restoreFromDrive() {
  setDriveStatus('syncing', 'Restoring…');
  try {
    const token = await getDriveToken(true);
    // Find the file
    if (!driveFileId) {
      const file = await findDriveFile(token);
      if (!file) {
        setDriveStatus('error', 'No backup');
        return { ok: false, error: 'No backup found in Drive' };
      }
      driveFileId = file.id;
    }
    const data = await downloadFromDrive(token, driveFileId);
    if (!data?.items) {
      return { ok: false, error: 'Backup file seems empty or corrupted' };
    }
    // Merge: keep local items not in backup, add/update from backup
    const existing = await dbAll();
    const existingIds = new Set(existing.map(i => i.id));
    let added = 0, updated = 0;
    for (const item of data.items) {
      if (existingIds.has(item.id)) { await dbPut(item); updated++; }
      else                          { await dbPut(item); added++; }
    }
    await loadItems();
    render();
    setDriveStatus('connected', 'Restored ✓');
    return { ok: true, added, updated, total: data.items.length };
  } catch(e) {
    console.error('Drive restore failed', e);
    setDriveStatus('error', 'Error');
    return { ok: false, error: e.message };
  }
}

// ── Drive modal UI ──
function openDriveModal() {
  const body = document.getElementById('drive-modal-body');
  const isConfigured = GOOGLE_CLIENT_ID !== 'YOUR_GOOGLE_CLIENT_ID_HERE';

  body.innerHTML = isConfigured ? `
    <div class="drive-info">
      Your pantry data is saved as a private file in your Google Drive that <strong>only this app can see</strong> — it won't appear in your normal Drive view.
      <br><br>
      You'll be asked to sign in to Google the first time.
    </div>

    <div class="sync-row">
      <div>
        <div class="sync-row-title">💾 Back up to Drive</div>
        <div class="sync-row-label">Save current pantry to your Drive</div>
      </div>
      <button class="btn-icon" id="btn-do-backup" title="Back up now">⬆️</button>
    </div>

    <div class="sync-row">
      <div>
        <div class="sync-row-title">📥 Restore from Drive</div>
        <div class="sync-row-label">Merge Drive backup into this device</div>
      </div>
      <button class="btn-icon" id="btn-do-restore" title="Restore now">⬇️</button>
    </div>

    <div id="drive-result" style="margin-top:14px;font-size:0.85rem;line-height:1.5;min-height:20px"></div>
    <button class="btn btn-secondary" onclick="closeModal('drive-modal')" style="margin-top:16px">Close</button>
  ` : `
    <div class="drive-info">
      <strong>⚙️ Client ID not set yet</strong><br><br>
      Open <code>app.js</code> and replace <code>YOUR_GOOGLE_CLIENT_ID_HERE</code> with the Client ID from your Google Cloud Console project.<br><br>
      Once that's done, push to GitHub and this button will work.
    </div>
    <button class="btn btn-secondary" onclick="closeModal('drive-modal')">Got it</button>`;

  if (isConfigured) {
    // Wire up after innerHTML is set
    setTimeout(() => {
      const resultEl = () => document.getElementById('drive-result');

      document.getElementById('btn-do-backup').onclick = async () => {
        resultEl().style.color = 'var(--muted)';
        resultEl().textContent = '⏳ Signing in and saving…';
        const r = await backupToDrive();
        resultEl().style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
        resultEl().textContent = r.ok
          ? '✅ Backup saved to your Google Drive.'
          : `❌ ${r.error}`;
      };

      document.getElementById('btn-do-restore').onclick = async () => {
        resultEl().style.color = 'var(--muted)';
        resultEl().textContent = '⏳ Signing in and restoring…';
        const r = await restoreFromDrive();
        resultEl().style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
        resultEl().textContent = r.ok
          ? `✅ Restored ${r.total} items (${r.added} new, ${r.updated} updated).`
          : `❌ ${r.error}`;
      };
    }, 0);
  }

  openModal('drive-modal');
}

// ═══════════════════════════════════════════════
//  PWA install
// ═══════════════════════════════════════════════
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  document.getElementById('btn-install').style.display = 'block';
});
document.getElementById('btn-install').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') document.getElementById('btn-install').style.display = 'none';
  deferredInstall = null;
};

// ═══════════════════════════════════════════════
//  Service Worker registration
// ═══════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(r => console.log('[SW] Registered', r.scope))
      .catch(e => console.warn('[SW] Failed', e));
  });
}

// ═══════════════════════════════════════════════
//  Wire up UI
// ═══════════════════════════════════════════════
document.getElementById('fab-scan').onclick = () => {
  scanData = {};
  openModal('scan-modal');
  showStep1();
};

document.getElementById('btn-drive').onclick = openDriveModal;

// Close modals on backdrop click
['scan-modal','detail-modal','drive-modal'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) closeModal(id);
  });
});

// Tab switching
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    render();
  });
});

// Search
document.getElementById('search').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  render();
});

// ═══════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════
(async () => {
  await openDB();
  await loadItems();
  render();
})();
