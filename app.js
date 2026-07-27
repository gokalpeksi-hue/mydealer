/* MyDealer — bayi rehberi. Veri: data.js (Excel'den), değişiklikler: localStorage overlay. */
'use strict';

const LS_KEY = 'mydealer_v1';
const PAGE = 60;

/* ---------- sunucu / kimlik ---------- */
/* Davet linki (?davet=TOKEN) ile çok kullanıcılı moda geçilir; token'sız açılışta
   cihaza gömülü veri (data.js) varsa eski tek kullanıcılı "yerel mod" çalışır. */
/* Üretim API'si: Google Apps Script web uygulaması (veri, yöneticinin Drive'ında).
   localStorage 'mydealer_api' ile geçersiz kılınabilir (yerel test: http://localhost:3100). */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz57kXHlPI6FBcwcIzi4atI7oPVabOdcd4itE_cfD5MIiFdzXlbnjfejwFNirAsI0NA/exec';
const API_BASE = localStorage.getItem('mydealer_api') || GAS_URL;
const GAS_MODE = API_BASE.includes('script.google');
const API = GAS_MODE ? API_BASE : API_BASE + '/api/mydealer';
const LOKAL_VERI = typeof BAYILER !== 'undefined' ? BAYILER : [];
let TOKEN = '';
{
  const p = new URLSearchParams(location.search);
  if (p.get('davet')) {
    TOKEN = p.get('davet').trim();
    localStorage.setItem('mydealer_token', TOKEN);
    history.replaceState(null, '', location.pathname); // token adres çubuğunda kalmasın
  } else {
    TOKEN = localStorage.getItem('mydealer_token') || '';
  }
}
let SRV = null; // {role, name, sehir, ilce, dealers, pendingCount, updated} — çevrimiçi mod
function isAdmin() { return SRV ? SRV.role === 'admin' : true; } // yerel mod = tek kullanıcı, tam yetki

function gasHata(j) { // Apps Script her zaman 200 döner; hata gövdede gelir
  if (j && j.error) throw Object.assign(new Error(j.error), { status: j.error === 'gecersiz_token' ? 401 : 400 });
  return j;
}
async function apiGet(path) {
  if (GAS_MODE) {
    const r = await fetch(`${API}?op=${path}&token=${encodeURIComponent(TOKEN)}`, { redirect: 'follow' });
    return gasHata(await r.json());
  }
  const r = await fetch(`${API}/${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`);
  if (!r.ok) throw Object.assign(new Error('api'), { status: r.status });
  return r.json();
}
async function apiPost(path, body) {
  if (GAS_MODE) {
    // content-type: text/plain → tarayıcı CORS ön uçuşu yapmaz (Apps Script OPTIONS yanıtlamaz)
    const r = await fetch(API, {
      method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ op: path, token: TOKEN }, body)),
      redirect: 'follow'
    });
    return gasHata(await r.json());
  }
  const r = await fetch(`${API}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ token: TOKEN }, body))
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'api'), { status: r.status });
  return j;
}

/* ---------- overlay durumu (ziyaret+favori her modda; edit/add/delete yalnız yerel mod) ---------- */
let ov = { edits: {}, added: [], deleted: [], visits: {}, favs: [] };
try { ov = Object.assign(ov, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(ov)); }

/* ---------- veri katmanı ---------- */
function allDealers() {
  if (SRV) return SRV.dealers;
  const del = new Set(ov.deleted);
  const out = [];
  for (const b of LOKAL_VERI) {
    if (del.has(b.id)) continue;
    out.push(ov.edits[b.id] ? Object.assign({}, b, ov.edits[b.id]) : b);
  }
  for (const b of ov.added) if (!del.has(b.id)) out.push(b);
  return out;
}
function getDealer(id) {
  if (SRV) return SRV.dealers.find(x => x.id === id) || null;
  if (ov.deleted.includes(id)) return null;
  const a = ov.added.find(x => x.id === id);
  if (a) return a;
  const b = LOKAL_VERI.find(x => x.id === id);
  return b ? (ov.edits[id] ? Object.assign({}, b, ov.edits[id]) : b) : null;
}

/* ---------- Türkçe normalize arama ---------- */
const TRMAP = { 'İ':'i','I':'ı','Ş':'ş','Ğ':'ğ','Ü':'ü','Ö':'ö','Ç':'ç' };
function trLower(s) { return String(s).replace(/[İIŞĞÜÖÇ]/g, c => TRMAP[c]).toLowerCase(); }
function fold(s) { // aksansız karşılaştırma: hem "izmir" hem "İZMİR" bulur
  return trLower(s).replace(/[ışğüöç]/g, c => ({ 'ı':'i','ş':'s','ğ':'g','ü':'u','ö':'o','ç':'c' }[c]));
}
function hay(b) {
  return fold([b.unvan, b.tabela, b.sehir, b.ilce, b.adres, b.tel, b.bolge, b.yorum, b.aciklama, b.vd].join(' '));
}

/* ---------- filtre durumu ---------- */
const F = { q: '', bolge: '', sehir: '', ilce: '', seg: '', durum: '', koord: false, eksik: false, ziyaretsiz: false, fav: false, near: false };
let geo = null; // {lat, lon}

function dist(a, b, c, d) { // km (haversine)
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function filtered() {
  const q = fold(F.q.trim());
  let arr = allDealers().filter(b => {
    if (F.bolge && b.bolge !== F.bolge) return false;
    if (F.sehir && b.sehir !== F.sehir) return false;
    if (F.ilce && b.ilce !== F.ilce) return false;
    if (F.seg && (b.segment || '(boş)') !== F.seg) return false;
    if (F.durum && (b.durum || '(boş)') !== F.durum) return false;
    if (F.koord && !b.lat) return false;
    if (F.eksik && (b.adres && b.tel)) return false;
    if (F.ziyaretsiz && (ov.visits[b.id] || []).length) return false;
    if (F.fav && !ov.favs.includes(b.id)) return false;
    if (q && !hay(b).includes(q)) return false;
    return true;
  });
  if (F.near && geo) {
    arr = arr.filter(b => b.lat).map(b => Object.assign({ _km: dist(geo.lat, geo.lon, b.lat, b.lon) }, b));
    arr.sort((a, b) => a._km - b._km);
  }
  return arr;
}

/* ---------- yardımcılar ---------- */
const $ = s => document.querySelector(s);
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function segColor(s) {
  if (!s) return '#8a97ab';
  if (s.startsWith('A')) return getComputedStyle(document.documentElement).getPropertyValue('--segA');
  return { B:'#1d4e9e', C:'#b07a12', D:'#8a5fc9' }[s[0]] || '#c2452d';
}
function telHref(t) { const d = String(t).replace(/\D/g, ''); return d ? 'tel:' + (d.length === 10 ? '0' + d : d) : ''; }
function waHref(t) { const d = String(t).replace(/\D/g, ''); if (!d) return ''; return 'https://wa.me/9' + (d.length === 10 ? '0' + d : d); }
function mapsHref(b) {
  if (b.lat) return `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`;
  const q = [b.tabela || b.unvan, b.ilce, b.sehir].filter(Boolean).join(' ');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}
function lastVisit(id) { const v = ov.visits[id] || []; return v.length ? v[v.length - 1] : null; }
function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }); }

/* ---------- liste ---------- */
let shown = PAGE, cur = [];
function card(b) {
  const seg = b.segment ? `<span class="tag seg" style="background:${segColor(b.segment)}">${esc(b.segment)}</span>` : '';
  const dur = b.durum ? `<span class="tag mis">${esc(b.durum)}</span>` : '';
  const lv = lastVisit(b.id);
  const vis = lv ? `<span class="tag vis">ziyaret: ${fmtDate(lv.t)}</span>` : '';
  const km = b._km !== undefined ? `<span class="tag dist">${b._km < 10 ? b._km.toFixed(1) : Math.round(b._km)} km</span>` : '';
  const mis = (!b.adres || !b.tel) ? `<span class="tag mis">eksik veri</span>` : '';
  const th = telHref(b.tel);
  return `<div class="bcard" data-id="${b.id}">
    <div class="bmain">
      <div class="bname">${esc(b.tabela || b.unvan)}</div>
      <div class="bsub">${esc([b.unvan !== b.tabela ? b.unvan : '', b.sehir, b.ilce].filter(Boolean).join(' · '))}</div>
      <div class="bmeta">${km}${seg}${dur}${b.bolge ? `<span class="tag">${esc(b.bolge)}</span>` : ''}${vis}${mis}</div>
    </div>
    <div class="bside">
      <button class="fav ${ov.favs.includes(b.id) ? 'on' : ''}" data-fav="${b.id}">⭐</button>
      ${th ? `<a class="callq" href="${th}" data-stop>📞</a>` : ''}
    </div>
  </div>`;
}
function renderGiris() {
  $('#count').textContent = '';
  $('#more').hidden = true;
  $('#list').innerHTML = `
    <div class="empty">
      ${TOKEN
        ? 'Sunucuya bağlanılamadı.<br>İnternetinizi kontrol edin — ilk açılışta yanıt 5-10 saniye sürebilir.'
        : 'Bu uygulama <b>davet linkiyle</b> çalışır.<br>Size gönderilen linki aşağıya yapıştırın:'}
      <input id="girisTok" placeholder="Davet linkini buraya yapıştırın" autocomplete="off"
        style="width:100%;border:1px solid var(--line);border-radius:10px;padding:11px;font-size:14px;margin-top:14px;background:#fff">
      <div style="margin-top:10px">
        <button class="btn pri" id="btnGiris">Bağlan</button>
        ${TOKEN ? '<button class="btn gry" id="btnTekrar" style="margin-left:8px">↻ Tekrar Dene</button>' : ''}
      </div>
    </div>`;
}
function renderList() {
  cur = filtered();
  if (!allDealers().length) { renderGiris(); renderChips(); return; }
  $('#count').textContent = cur.length.toLocaleString('tr-TR') + ' bayi';
  const slice = cur.slice(0, shown);
  $('#list').innerHTML = slice.length ? slice.map(card).join('') : '<div class="empty">Eşleşen bayi yok.<br>Filtreleri veya aramayı değiştirin.</div>';
  $('#more').hidden = cur.length <= shown;
  renderChips();
}
function renderChips() {
  const c = [];
  if (F.bolge) c.push(['Bölge', F.bolge]); if (F.sehir) c.push(['Şehir', F.sehir]);
  if (F.ilce) c.push(['İlçe', F.ilce]); if (F.seg) c.push(['Segment', F.seg]);
  if (F.durum) c.push(['Durum', F.durum]); if (F.koord) c.push(['', 'Koordinatlı']);
  if (F.eksik) c.push(['', 'Eksik verili']); if (F.ziyaretsiz) c.push(['', 'Ziyaretsiz']);
  if (F.near) c.push(['', '📍 Yakınımdakiler']); if (F.fav) c.push(['', '⭐ Favoriler']);
  $('#chips').innerHTML = c.map(x => `<span class="chip">${x[0] ? esc(x[0]) + ':' : ''}<b>${esc(x[1])}</b></span>`).join('');
  $('#btnFilter').classList.toggle('on', !!(F.bolge || F.sehir || F.ilce || F.seg || F.durum || F.koord || F.eksik || F.ziyaretsiz));
}

/* ---------- filtre sheet ---------- */
function fillSelect(el, vals, curVal, label) {
  el.innerHTML = `<option value="">${label} (tümü)</option>` + vals.map(v => `<option${v === curVal ? ' selected' : ''}>${esc(v)}</option>`).join('');
}
function buildFilters() {
  const all = allDealers();
  const uniq = k => [...new Set(all.map(b => b[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  fillSelect($('#fBolge'), uniq('bolge'), F.bolge, 'Bölge');
  const cities = F.bolge ? [...new Set(all.filter(b => b.bolge === F.bolge).map(b => b.sehir).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')) : uniq('sehir');
  fillSelect($('#fSehir'), cities, F.sehir, 'Şehir');
  const ilceler = F.sehir ? [...new Set(all.filter(b => b.sehir === F.sehir).map(b => b.ilce).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr')) : [];
  fillSelect($('#fIlce'), ilceler, F.ilce, F.sehir ? 'İlçe' : 'İlçe (önce şehir seçin)');
  const segs = [...new Set(all.map(b => b.segment || '(boş)'))].sort();
  fillSelect($('#fSeg'), segs, F.seg, 'Segment');
  const durs = [...new Set(all.map(b => b.durum || '(boş)'))].sort();
  fillSelect($('#fDurum'), durs, F.durum, 'Durum');
  $('#fKoord').checked = F.koord; $('#fEksik').checked = F.eksik; $('#fZiyaretsiz').checked = F.ziyaretsiz;
}

/* ---------- detay ---------- */
const FIELDS = [
  ['unvan', 'Bayi Ünvanı'], ['tabela', 'Tabela İsmi'], ['bolge', 'Bölge'], ['sehir', 'Şehir'],
  ['ilce', 'İlçe'], ['adres', 'Adres'], ['segment', 'Segment'], ['durum', 'Durum'],
  ['tel', 'Telefon'], ['lat', 'Enlem'], ['lon', 'Boylam'], ['vd', 'Vergi Dairesi'],
  ['vno', 'Vergi No'], ['tc', 'TC Kimlik No'], ['mudur', 'Bölge Müdürü'],
  ['yorum', 'Saha Yorumu'], ['aciklama', 'Saha Açıklama']
];
function openDetail(id) {
  const b = getDealer(id);
  if (!b) return;
  const th = telHref(b.tel), wh = waHref(b.tel), mh = mapsHref(b);
  const visits = (ov.visits[id] || []).slice().reverse();
  $('#detailBody').innerHTML = `
    <div class="sh-head"><h2 style="flex:1">Bayi Detayı</h2><button class="sh-x" data-close="shDetail">✕</button></div>
    <div class="d-head">
      <div class="d-title">
        <h2>${esc(b.tabela || b.unvan)}</h2>
        <p>${esc([b.unvan, b.sehir, b.ilce].filter(Boolean).join(' · '))}</p>
        <div class="bmeta" style="margin-top:8px">
          ${b.segment ? `<span class="tag seg" style="background:${segColor(b.segment)}">Segment ${esc(b.segment)}</span>` : ''}
          ${b.durum ? `<span class="tag mis">${esc(b.durum)}</span>` : ''}
          ${b.bolge ? `<span class="tag">${esc(b.bolge)}</span>` : ''}
        </div>
      </div>
      <button class="fav ${ov.favs.includes(id) ? 'on' : ''}" data-fav="${id}" style="font-size:24px">⭐</button>
    </div>
    <div class="d-acts">
      <a class="d-act ${th ? '' : 'dis'}" href="${th || '#'}"><i>📞</i>Ara</a>
      <a class="d-act ${wh ? '' : 'dis'}" href="${wh || '#'}" target="_blank" rel="noopener"><i>💬</i>WhatsApp</a>
      <a class="d-act ${mh ? '' : 'dis'}" href="${mh || '#'}" target="_blank" rel="noopener"><i>🗺️</i>Haritada Aç</a>
      <button class="d-act" data-edit="${id}"><i>✏️</i>Düzenle</button>
    </div>
    <div class="kv"><dl>${FIELDS.map(f => `<dt>${f[1]}</dt><dd>${esc(b[f[0]] || '—')}</dd>`).join('')}</dl></div>
    <h4 class="sec">Ziyaret Notları (${visits.length})</h4>
    <div class="frow"><textarea id="visNote" placeholder="Ziyaret notu yazın… (ör. sipariş aldı, tabela yenilenecek)"></textarea></div>
    <div class="btnrow"><button class="btn grn" data-visit="${id}">+ Ziyaret Kaydet</button></div>
    <div style="margin-top:10px">${visits.map((v, i) => `<div class="vis-item"><small>${fmtDate(v.t)}</small>${esc(v.n)}<button style="float:right;color:var(--warn);font-size:12px" data-delvis="${id}|${visits.length - 1 - i}">sil</button></div>`).join('') || '<p style="font-size:13px;color:var(--mut)">Henüz ziyaret kaydı yok.</p>'}</div>
    <div class="btnrow" style="margin-top:16px"><button class="btn red" data-del="${id}">🗑️ Bayiyi Listeden Çıkar</button></div>`;
  $('#shDetail').classList.add('on');
}

/* ---------- düzenle / ekle ---------- */
function openEdit(id) {
  const b = id ? getDealer(id) : {};
  const segs = ['', 'A+', 'A', 'B', 'C', 'D', 'KAPALI'];
  const durs = ['', 'A+', 'A', 'B', 'C', 'D', 'SORUNLU', 'KAPALI'];
  $('#editBody').innerHTML = `
    <div class="sh-head"><h2>${id ? 'Bayi Düzenle' : 'Yeni Bayi Ekle'}</h2><button class="sh-x" data-close="shEdit">✕</button></div>
    ${FIELDS.map(f => {
      const v = esc(b[f[0]] || '');
      if (f[0] === 'segment') return `<div class="frow"><label>${f[1]}</label><select id="e_segment">${segs.map(s => `<option${s === (b.segment || '') ? ' selected' : ''}>${s}</option>`).join('')}</select></div>`;
      if (f[0] === 'durum') return `<div class="frow"><label>${f[1]}</label><select id="e_durum">${durs.map(s => `<option${s === (b.durum || '') ? ' selected' : ''}>${s}</option>`).join('')}</select></div>`;
      if (f[0] === 'adres' || f[0] === 'yorum' || f[0] === 'aciklama') return `<div class="frow"><label>${f[1]}</label><textarea id="e_${f[0]}">${v}</textarea></div>`;
      return `<div class="frow"><label>${f[1]}</label><input id="e_${f[0]}" value="${v}"${f[0] === 'lat' || f[0] === 'lon' ? ' inputmode="decimal" placeholder="ör. 38.4192"' : ''}></div>`;
    }).join('')}
    <div class="btnrow">
      <button class="btn gry" data-close="shEdit">Vazgeç</button>
      <button class="btn pri" id="btnSaveEdit" data-id="${id || ''}">Kaydet</button>
    </div>`;
  $('#shEdit').classList.add('on');
}
async function saveEdit(id) {
  const rec = {};
  for (const f of FIELDS) {
    let v = $('#e_' + f[0]).value.trim();
    if (f[0] === 'lat' || f[0] === 'lon') { v = v.replace(',', '.'); const n = parseFloat(v); v = isNaN(n) ? '' : n; }
    rec[f[0]] = v === '' ? '' : v;
  }
  if (!rec.unvan && !rec.tabela) { alert('En azından ünvan veya tabela ismi girin.'); return; }
  if (!rec.lat || !rec.lon) { rec.lat = ''; rec.lon = ''; }

  if (SRV) { // ---- çevrimiçi mod: sunucuya gönder ----
    try {
      let sonuc;
      if (id) {
        const base = getDealer(id) || {};
        const diff = {};
        for (const k in rec) if (rec[k] !== (base[k] === undefined ? '' : base[k])) diff[k] = rec[k];
        if (!Object.keys(diff).length) { $('#shEdit').classList.remove('on'); return; }
        sonuc = await apiPost('change', { type: 'edit', dealerId: id, fields: diff });
        if (sonuc.sonuc === 'uygulandi') {
          Object.assign(SRV.dealers.find(x => x.id === id) || {}, diff);
        }
      } else {
        sonuc = await apiPost('change', { type: 'add', fields: rec });
        if (sonuc.sonuc === 'uygulandi') { id = sonuc.dealerId; SRV.dealers.push(Object.assign({ id }, rec)); }
      }
      $('#shEdit').classList.remove('on'); $('#shDetail').classList.remove('on');
      mapDirty = true; shown = PAGE;
      renderList(); if (viewNow === 'map') buildMap(); if (viewNow === 'stats') renderStats();
      if (sonuc.sonuc === 'onaya_gonderildi') alert('Değişiklik yöneticinin onayına gönderildi. ✓\nOnaylanınca yayına girecek.');
      else if (id) openDetail(id);
    } catch (e) {
      alert(e.message === 'yetki_disi_bolge' ? 'Bu bayi yetkili olduğunuz şehir/ilçe dışında.' : 'Kaydedilemedi (internet/sunucu): ' + e.message);
    }
    return;
  }

  // ---- yerel mod ----
  const rl = {};
  for (const k in rec) if (rec[k] !== '') rl[k] = rec[k];
  if (id) {
    const ai = ov.added.findIndex(x => x.id === id);
    if (ai >= 0) ov.added[ai] = Object.assign({ id }, rl);
    else {
      const base = LOKAL_VERI.find(x => x.id === id) || {};
      const diff = {};
      for (const k in rec) if (rec[k] !== (base[k] === undefined ? '' : base[k])) diff[k] = rec[k];
      if (Object.keys(diff).length) ov.edits[id] = Object.assign(ov.edits[id] || {}, diff);
    }
  } else {
    id = 'y' + Date.now();
    ov.added.push(Object.assign({ id }, rl));
  }
  save();
  $('#shEdit').classList.remove('on');
  $('#shDetail').classList.remove('on');
  mapDirty = true; shown = PAGE;
  renderList(); if (viewNow === 'map') buildMap(); if (viewNow === 'stats') renderStats();
  openDetail(id);
}

/* ---------- harita ---------- */
let map = null, cluster = null, mapDirty = true, viewNow = 'home';
function buildMap() {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([39.0, 34.5], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);
    cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 46 });
    map.addLayer(cluster);
  }
  cluster.clearLayers();
  const arr = filtered().filter(b => b.lat);
  for (const b of arr) {
    const m = L.marker([b.lat, b.lon], {
      icon: L.divIcon({ className: '', html: `<div class="mpin" style="width:16px;height:16px;background:${segColor(b.segment)}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] })
    });
    m.bindPopup(`<div class="pop-name">${esc(b.tabela || b.unvan)}</div>
      <div style="color:#667">${esc([b.sehir, b.ilce, b.segment ? 'Segment ' + b.segment : ''].filter(Boolean).join(' · '))}</div>
      <div class="pop-btns"><button onclick="openDetail('${b.id}')">Detay</button>${telHref(b.tel) ? `<a href="${telHref(b.tel)}">📞 Ara</a>` : ''}</div>`);
    cluster.addLayer(m);
  }
  $('#mapNote').textContent = arr.length.toLocaleString('tr-TR') + ' bayi haritada · koordinatı olmayanlar listede görünür';
  if (arr.length && arr.length < 400) { try { map.fitBounds(cluster.getBounds().pad(0.2)); } catch (e) {} }
  mapDirty = false;
  setTimeout(() => map.invalidateSize(), 60);
}
window.openDetail = openDetail; // harita popup butonu için

/* ---------- pivot ---------- */
const PDIMS = [['bolge', 'Bölge'], ['sehir', 'Şehir'], ['ilce', 'İlçe'], ['segment', 'Klasman']];
const piv = { dim: 'bolge', path: [] }; // path: [{dim, value}]
function pivotBase() {
  let arr = filtered();
  for (const p of piv.path) arr = arr.filter(b => (b[p.dim] || '(boş)') === p.value);
  return arr;
}
function renderPivot() {
  const usedDims = new Set(piv.path.map(p => p.dim));
  $('#pivotDims').innerHTML = PDIMS.filter(d => !usedDims.has(d[0]))
    .map(d => `<button class="pdim ${piv.dim === d[0] ? 'on' : ''}" data-pdim="${d[0]}">${d[1]}</button>`).join('');
  $('#pivotCrumb').innerHTML = piv.path.length
    ? '<button data-pcrumb="-1">Tümü</button>' + piv.path.map((p, i) =>
        ` › <button data-pcrumb="${i}">${esc(p.value)}</button>`).join('')
    : '';
  const arr = pivotBase();
  const m = {};
  for (const b of arr) { const v = b[piv.dim] || '(boş)'; m[v] = (m[v] || 0) + 1; }
  const rows = Object.entries(m).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(r => r[1]), 1);
  const dimName = PDIMS.find(d => d[0] === piv.dim)[1];
  const derin = PDIMS.some(d => !usedDims.has(d[0]) && d[0] !== piv.dim);
  $('#pivot').innerHTML = rows.length ? rows.map(r => `
    <div class="prow" ${derin ? `data-pin="${esc(r[0])}"` : ''}>
      <span class="pname">${esc(r[0])}</span>
      <span class="pbar"><i style="width:${Math.round(r[1] / max * 100)}%"></i></span>
      <span class="pcnt">${r[1]}</span>
      <button class="pgo" data-plist="${esc(r[0])}">Liste</button>
    </div>`).join('') +
    `<p style="font-size:12px;color:var(--mut);text-align:center;padding:6px">${arr.length} bayi · ${dimName} kırılımı${derin ? ' · satıra dokunup derine inin' : ''}</p>`
    : '<div class="empty">Bu kırılımda kayıt yok.</div>';
}
function pivotToList(value) {
  // pivot yolunu + seçilen değeri liste filtrelerine uygula
  F.bolge = F.sehir = F.ilce = F.seg = '';
  const uygula = (dim, val) => {
    if (dim === 'bolge') F.bolge = val === '(boş)' ? '' : val;
    if (dim === 'sehir') F.sehir = val === '(boş)' ? '' : val;
    if (dim === 'ilce') F.ilce = val === '(boş)' ? '' : val;
    if (dim === 'segment') F.seg = val;
  };
  for (const p of piv.path) uygula(p.dim, p.value);
  if (value !== null) uygula(piv.dim, value);
  shown = PAGE; mapDirty = true;
  document.querySelector('nav button[data-v="list"]').click();
  renderList();
}

/* ---------- özet ---------- */
function bars(pairs, total) {
  const max = Math.max(...pairs.map(p => p[1]), 1);
  return pairs.map(p => `<div class="bar"><span>${esc(p[0])}</span><i style="width:${Math.round(p[1] / max * 100) * 0.6}%"></i><b>${p[1]}</b></div>`).join('');
}
function renderStats() {
  const all = allDealers();
  const cnt = k => { const m = {}; for (const b of all) { const v = b[k] || '(boş)'; m[v] = (m[v] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const visCount = Object.values(ov.visits).reduce((s, v) => s + v.length, 0);
  const visited = Object.keys(ov.visits).filter(id => (ov.visits[id] || []).length && getDealer(id)).length;
  const missing = all.filter(b => !b.adres || !b.tel).length;
  $('#stats').innerHTML = `
    <div class="scard"><h3>Genel</h3><div class="bigrow">
      <div><div class="bignum">${all.length.toLocaleString('tr-TR')}</div><div class="biglab">Toplam Bayi</div></div>
      <div><div class="bignum">${all.filter(b => b.lat).length}</div><div class="biglab">Koordinatlı</div></div>
      <div><div class="bignum">${visited}</div><div class="biglab">Ziyaret Edilen</div></div>
      <div><div class="bignum">${missing}</div><div class="biglab">Eksik Verili</div></div>
    </div></div>
    <div class="scard"><h3>Segment Dağılımı</h3>${bars(cnt('segment'), all.length)}</div>
    <div class="scard"><h3>Bölge Dağılımı</h3>${bars(cnt('bolge'), all.length)}</div>
    <div class="scard"><h3>En Çok Bayisi Olan 12 Şehir</h3>${bars(cnt('sehir').filter(p => p[0] !== '(boş)').slice(0, 12), all.length)}</div>
    <div class="scard"><h3>Değişiklikler</h3>
      <div class="bigrow">
        <div><div class="bignum">${Object.keys(ov.edits).length}</div><div class="biglab">Düzenlenen</div></div>
        <div><div class="bignum">${ov.added.length}</div><div class="biglab">Eklenen</div></div>
        <div><div class="bignum">${ov.deleted.length}</div><div class="biglab">Çıkarılan</div></div>
        <div><div class="bignum">${visCount}</div><div class="biglab">Ziyaret Notu</div></div>
      </div></div>`;
}

/* ---------- yedek / csv ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function backup() {
  const d = new Date().toISOString().slice(0, 10);
  download(`mydealer-yedek-${d}.json`, JSON.stringify({ app: 'mydealer', v: 1, date: d, overlay: ov }), 'application/json');
}
function mergeBackup(j) {
  if (!j || j.app !== 'mydealer' || !j.overlay) return false;
  const o = j.overlay;
  Object.assign(ov.edits, o.edits || {});
  for (const a of o.added || []) if (!ov.added.some(x => x.id === a.id)) ov.added.push(a);
  for (const d of o.deleted || []) if (!ov.deleted.includes(d)) ov.deleted.push(d);
  for (const id in o.visits || {}) {
    ov.visits[id] = ov.visits[id] || [];
    for (const v of o.visits[id]) if (!ov.visits[id].some(x => x.t === v.t && x.n === v.n)) ov.visits[id].push(v);
    ov.visits[id].sort((a, b) => a.t < b.t ? -1 : 1);
  }
  for (const f of o.favs || []) if (!ov.favs.includes(f)) ov.favs.push(f);
  save(); shown = PAGE; mapDirty = true;
  renderList(); renderStats();
  return true;
}
function restore(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      if (!mergeBackup(JSON.parse(r.result))) throw 0;
      alert('Yedek birleştirildi. ✓');
    } catch (e) { alert('Geçersiz yedek dosyası.'); }
  };
  r.readAsText(file);
}

/* ---------- Google Drive yedekleme ---------- */
/* drive.file kapsamı: uygulama yalnızca kendi oluşturduğu dosyaları görür. */
const GCID_KEY = 'mydealer_gcid';
// Varsayılan istemci: Google Cloud "MyDealer" projesi (mydealer-501913), MyDealer Web istemcisi.
// Client ID gizli değildir; izinli origin listesi Google konsolunda tutulur (localhost:5604).
const GCID_DEFAULT = '335808054231-tnvr6fh8569nthutb5s3un261s9ans3n.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
let gToken = null, gTokenExp = 0;

function driveCfg(force) {
  let id = (localStorage.getItem(GCID_KEY) || '').trim();
  if (force) {
    const yeni = prompt('Google OAuth Client ID (boş bırakırsanız varsayılan kullanılır):', id || GCID_DEFAULT);
    if (yeni !== null) {
      id = yeni.trim();
      if (id && id !== GCID_DEFAULT) localStorage.setItem(GCID_KEY, id);
      else { localStorage.removeItem(GCID_KEY); id = ''; }
    }
  }
  return id || GCID_DEFAULT;
}
function loadGis() {
  return new Promise((res, rej) => {
    if (window.google && google.accounts) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res(); s.onerror = () => rej(new Error('Google girişi yüklenemedi (internet?)'));
    document.head.appendChild(s);
  });
}
async function driveAuth() {
  const cid = driveCfg(false);
  if (!cid) throw new Error('Client ID girilmedi.');
  if (gToken && Date.now() < gTokenExp - 60000) return gToken;
  await loadGis();
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope: DRIVE_SCOPE,
      callback: t => {
        if (t.error) return rej(new Error(t.error));
        gToken = t.access_token; gTokenExp = Date.now() + (t.expires_in || 3600) * 1000;
        res(gToken);
      }
    });
    tc.requestAccessToken();
  });
}
async function gFetch(url, opt) {
  const tok = await driveAuth();
  opt = opt || {}; opt.headers = Object.assign({ Authorization: 'Bearer ' + tok }, opt.headers || {});
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error('Drive isteği başarısız (' + r.status + ')');
  return r;
}
async function driveBackup() {
  const btn = $('#btnDriveBackup'); btn.disabled = true;
  try {
    const name = 'mydealer-yedek-' + new Date().toISOString().slice(0, 10) + '.json';
    const body = JSON.stringify({ app: 'mydealer', v: 1, date: new Date().toISOString(), overlay: ov });
    // aynı isimli dosya varsa üzerine yaz, yoksa oluştur
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const list = await (await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`)).json();
    const meta = { name, mimeType: 'application/json' };
    const boundary = 'mydealer' + Date.now();
    const mp = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const url = list.files && list.files.length
      ? `https://www.googleapis.com/upload/drive/v3/files/${list.files[0].id}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    await gFetch(url, {
      method: list.files && list.files.length ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: mp
    });
    alert('Drive\'a yedeklendi: ' + name + ' ✓');
  } catch (e) { alert('Drive yedekleme olmadı: ' + e.message); }
  btn.disabled = false;
}
async function driveRestore() {
  const btn = $('#btnDriveRestore'); btn.disabled = true;
  try {
    const q = encodeURIComponent("name contains 'mydealer-yedek' and trashed=false");
    const list = await (await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=10&fields=files(id,name,modifiedTime,size)`)).json();
    const files = list.files || [];
    if (!files.length) { alert('Drive\'da MyDealer yedeği bulunamadı.\n(Not: yalnızca bu uygulamanın yüklediği dosyalar görünür; elle yüklediğiniz eski yedekleri "Geri Yükle (dosyadan)" ile alın.)'); btn.disabled = false; return; }
    $('#driveBody').innerHTML = `
      <div class="sh-head"><h2>Drive Yedekleri</h2><button class="sh-x" data-close="shDrive">✕</button></div>
      ${files.map(f => `<button class="set-btn" data-gfile="${f.id}">☁️ ${esc(f.name)}<small>${fmtDate(f.modifiedTime)} · ${f.size ? Math.round(f.size / 1024) + ' KB' : ''}</small></button>`).join('')}`;
    $('#shDrive').classList.add('on');
  } catch (e) { alert('Drive listesi alınamadı: ' + e.message); }
  btn.disabled = false;
}
async function driveLoadFile(id) {
  try {
    const j = await (await gFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
    if (!mergeBackup(j)) throw new Error('dosya MyDealer yedeği değil');
    $('#shDrive').classList.remove('on');
    alert('Drive yedeği birleştirildi. ✓');
  } catch (e) { alert('Geri yükleme olmadı: ' + e.message); }
}
function csvExport() {
  const cols = FIELDS.map(f => f[1]);
  const rows = [cols.join(';')];
  for (const b of filtered()) {
    rows.push(FIELDS.map(f => '"' + String(b[f[0]] === undefined ? '' : b[f[0]]).replace(/"/g, '""') + '"').join(';'));
  }
  download(`mydealer-liste-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
}

/* ---------- onay kuyruğu (admin) ---------- */
const FALAN = Object.fromEntries(FIELDS); // alan adı → etiket
async function openPending() {
  $('#pendingBody').innerHTML = '<div class="sh-head"><h2>Onay Bekleyenler</h2><button class="sh-x" data-close="shPending">✕</button></div><p class="srvnote">Yükleniyor…</p>';
  $('#shPending').classList.add('on');
  try {
    const r = await apiGet('pending');
    $('#pendingBody').innerHTML = `
      <div class="sh-head"><h2>Onay Bekleyenler (${r.items.length})</h2><button class="sh-x" data-close="shPending">✕</button></div>` +
      (r.items.length ? r.items.map(x => {
        const tur = { edit: 'Düzenleme', add: 'Yeni bayi', delete: 'Silme' }[x.type];
        let govde = '';
        if (x.type === 'edit') {
          govde = Object.keys(x.fields).map(k =>
            `<div class="diff">${esc(FALAN[k] || k)}: <s>${esc(String((x.eski && x.eski[k]) || '—'))}</s> <b>${esc(String(x.fields[k] || '—'))}</b></div>`).join('');
        } else if (x.type === 'add') {
          govde = Object.entries(x.fields).filter(e => e[1]).map(e =>
            `<div class="diff">${esc(FALAN[e[0]] || e[0])}: <b>${esc(String(e[1]))}</b></div>`).join('');
        } else govde = '<div class="diff"><s>Bayi listeden silinecek</s></div>';
        return `<div class="pend-card">
          <div class="pend-head"><b>${esc(x.name)}</b> · ${tur} · <b>${esc(x.dealerAdi)}</b> · ${fmtDate(x.ts)}</div>
          ${govde}
          <div class="pend-btns">
            <button class="ok" data-karar="onay|${x.id}">✓ Onayla</button>
            <button class="no" data-karar="red|${x.id}">✕ Reddet</button>
          </div></div>`;
      }).join('') : '<p class="srvnote">Bekleyen değişiklik yok. 🎉</p>');
  } catch (e) {
    $('#pendingBody').innerHTML += `<p class="srvnote">Liste alınamadı: ${esc(e.message)}</p>`;
  }
}
async function karar(k, id) {
  try {
    await apiPost('decide', { id, karar: k });
    await syncData(true); // onaylanan değişiklik listeye yansısın
    openPending();
  } catch (e) { alert('Olmadı: ' + e.message); }
}

/* ---------- davet yönetimi (admin) ---------- */
async function openInvites() {
  const all = allDealers();
  const sehirler = [...new Set(all.map(b => b.sehir).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  $('#inviteBody').innerHTML = `
    <div class="sh-head"><h2>Davet Yönetimi</h2><button class="sh-x" data-close="shInvite">✕</button></div>
    <div class="frow"><label>Davetlinin adı</label><input id="invName" placeholder="ör. Ahmet Yılmaz (Ege saha)"></div>
    <div class="frow"><label>Yetkili şehirler (boş = tüm şehirler)</label>
      <div class="chkbox" id="invSehir">${sehirler.map(s => `<label><input type="checkbox" value="${esc(s)}">${esc(s)}</label>`).join('')}</div></div>
    <div class="frow"><label>Yetkili ilçeler (isteğe bağlı; boş = seçilen şehirlerin tamamı)</label>
      <div class="chkbox" id="invIlce"><p class="srvnote">Önce şehir seçin</p></div></div>
    <div class="btnrow"><button class="btn grn" id="btnCreateInvite">+ Davet Linki Üret</button></div>
    <h4 class="sec">Mevcut Davetler</h4><div id="invList"><p class="srvnote">Yükleniyor…</p></div>`;
  $('#shInvite').classList.add('on');
  $('#invSehir').addEventListener('change', () => {
    const secili = [...$('#invSehir').querySelectorAll('input:checked')].map(i => i.value);
    const ilceler = [...new Set(all.filter(b => secili.includes(b.sehir)).map(b => b.ilce).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
    $('#invIlce').innerHTML = ilceler.length
      ? ilceler.map(s => `<label><input type="checkbox" value="${esc(s)}">${esc(s)}</label>`).join('')
      : '<p class="srvnote">Önce şehir seçin</p>';
  });
  renderInviteList();
}
function inviteLink(tok) { return `${location.origin}${location.pathname}?davet=${tok}`; }
async function renderInviteList() {
  try {
    const r = await apiGet('invites');
    $('#invList').innerHTML = r.users.length ? r.users.slice().reverse().map(u => `
      <div class="inv-card" style="${u.active ? '' : 'opacity:.5'}">
        <b>${esc(u.name)}</b> ${u.active ? '' : '· <span style="color:var(--warn)">iptal edildi</span>'}
        <small>${esc((u.sehir || []).join(', ') || 'Tüm şehirler')}${u.ilce && u.ilce.length ? ' · ' + esc(u.ilce.join(', ')) : ''} · ${fmtDate(u.created)}</small>
        ${u.active ? `<div class="inv-act">
          <button data-copy="${esc(inviteLink(u.token))}">🔗 Linki Kopyala</button>
          <a href="https://wa.me/?text=${encodeURIComponent('MyDealer bayi rehberi davet linkiniz: ' + inviteLink(u.token))}" target="_blank" rel="noopener">💬 WhatsApp</a>
          <button class="rev" data-revoke="${esc(u.token)}">İptal Et</button>
        </div>` : ''}
      </div>`).join('') : '<p class="srvnote">Henüz davet yok.</p>';
  } catch (e) { $('#invList').innerHTML = `<p class="srvnote">Liste alınamadı: ${esc(e.message)}</p>`; }
}
async function createInvite() {
  const name = $('#invName').value.trim();
  if (!name) { alert('Davetlinin adını yazın.'); return; }
  const sehir = [...$('#invSehir').querySelectorAll('input:checked')].map(i => i.value);
  const ilce = [...$('#invIlce').querySelectorAll('input:checked')].map(i => i.value);
  try {
    const r = await apiPost('invite', { name, sehir, ilce });
    renderInviteList();
    const link = inviteLink(r.token);
    try { await navigator.clipboard.writeText(link); } catch (e) {}
    alert(`Davet hazır ve panoya kopyalandı: ${name}\n${link}\n\nBu linki yalnızca o kişiye gönderin — link kimin elindeyse o girebilir.`);
  } catch (e) { alert('Davet üretilemedi: ' + e.message); }
}

/* ---------- onaya gönderdiklerim (editör) ---------- */
function openMyPending() {
  const items = (SRV && SRV.myPending || []).slice().reverse();
  const rozet = { pending: '🕓 bekliyor', onaylandi: '✅ onaylandı', reddedildi: '❌ reddedildi' };
  $('#pendingBody').innerHTML = `
    <div class="sh-head"><h2>Onaya Gönderdiklerim</h2><button class="sh-x" data-close="shPending">✕</button></div>` +
    (items.length ? items.map(x => `
      <div class="inv-card"><b>${esc(x.dealerAdi)}</b> · ${({ edit: 'düzenleme', add: 'yeni bayi', delete: 'silme' })[x.type]}
      <small>${fmtDate(x.ts)} · ${rozet[x.status] || x.status}</small></div>`).join('')
      : '<p class="srvnote">Henüz öneri göndermediniz.</p>');
  $('#shPending').classList.add('on');
}

/* ---------- sunucu senkron / açılış ---------- */
function applyRoleUI() {
  $('#adminBox').style.display = SRV && isAdmin() ? '' : 'none';
  $('#editorBox').style.display = SRV && !isAdmin() ? '' : 'none';
  $('#btnSync').style.display = SRV ? '' : 'none';
  $('#whoami').textContent = SRV ? `${SRV.name} · ${isAdmin() ? 'yönetici' : 'saha'}` : 'bayi rehberi';
  $('#pendBadge').textContent = SRV && SRV.pendingCount ? String(SRV.pendingCount) : '';
  $('#fab').style.display = (viewNow === 'list' || viewNow === 'home') ? '' : 'none';
  $('#btnHome').hidden = viewNow === 'home';
}
async function syncData(sessiz) {
  if (!TOKEN) return false;
  try {
    const r = await apiGet('data');
    SRV = r;
    localStorage.setItem('mydealer_cache', JSON.stringify(r));
    shown = PAGE; mapDirty = true;
    renderList(); applyRoleUI();
    if (viewNow === 'map') buildMap();
    if (viewNow === 'stats') renderStats();
    if (viewNow === 'pivot') renderPivot();
    if (viewNow === 'home') renderHome();
    return true;
  } catch (e) {
    if (e.status === 401) {
      localStorage.removeItem('mydealer_token');
      if (!sessiz) alert('Davet linkiniz geçersiz veya iptal edilmiş. Yöneticiyle iletişime geçin.');
      TOKEN = '';
      return false;
    }
    // çevrimdışı: önbellekten oku
    const c = localStorage.getItem('mydealer_cache');
    if (c) {
      try { SRV = JSON.parse(c); renderList(); applyRoleUI(); if (!sessiz) alert('Sunucuya ulaşılamadı; son indirilen liste gösteriliyor (salt okunur gibi davranın).'); return true; } catch (e2) {}
    }
    if (!sessiz) alert('Sunucuya ulaşılamadı. İnternetinizi kontrol edin.\n(İlk açılışta sunucunun uyanması 30-60 sn sürebilir, tekrar deneyin.)');
    return false;
  }
}

/* ---------- olaylar ---------- */
document.querySelectorAll('nav button').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b === btn));
  viewNow = btn.dataset.v;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + viewNow));
  $('#fab').style.display = (viewNow === 'list' || viewNow === 'home') ? '' : 'none';
  $('#btnHome').hidden = viewNow === 'home';
  if (viewNow === 'map' && mapDirty) buildMap();
  else if (viewNow === 'map') setTimeout(() => map && map.invalidateSize(), 60);
  if (viewNow === 'stats') renderStats();
  if (viewNow === 'pivot') renderPivot();
  if (viewNow === 'home') renderHome();
}));

let qTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { F.q = e.target.value; shown = PAGE; mapDirty = true; renderList(); if (viewNow === 'map') buildMap(); if (viewNow === 'home') renderHome(); }, 200);
});
$('#more').addEventListener('click', () => { shown += PAGE; renderList(); });
$('#btnFilter').addEventListener('click', () => { buildFilters(); $('#shFilter').classList.add('on'); });
$('#btnClearF').addEventListener('click', () => {
  F.bolge = F.sehir = F.ilce = F.seg = F.durum = ''; F.koord = F.eksik = F.ziyaretsiz = false;
  buildFilters(); applyFilters();
});
function applyFilters() { shown = PAGE; mapDirty = true; renderList(); if (viewNow === 'map') buildMap(); if (viewNow === 'home') renderHome(); }
$('#fBolge').addEventListener('change', e => { F.bolge = e.target.value; F.sehir = ''; F.ilce = ''; buildFilters(); applyFilters(); });
$('#fSehir').addEventListener('change', e => { F.sehir = e.target.value; F.ilce = ''; buildFilters(); applyFilters(); });
$('#fIlce').addEventListener('change', e => { F.ilce = e.target.value; applyFilters(); });
$('#fSeg').addEventListener('change', e => { F.seg = e.target.value; applyFilters(); });
$('#fDurum').addEventListener('change', e => { F.durum = e.target.value; applyFilters(); });
$('#fKoord').addEventListener('change', e => { F.koord = e.target.checked; applyFilters(); });
$('#fEksik').addEventListener('change', e => { F.eksik = e.target.checked; applyFilters(); });
$('#fZiyaretsiz').addEventListener('change', e => { F.ziyaretsiz = e.target.checked; applyFilters(); });

$('#btnNear').addEventListener('click', () => {
  if (F.near) { F.near = false; $('#btnNear').classList.remove('on'); renderList(); return; }
  if (!navigator.geolocation) { alert('Bu cihazda konum desteği yok.'); return; }
  $('#btnNear').textContent = '📍 Konum alınıyor…';
  navigator.geolocation.getCurrentPosition(p => {
    geo = { lat: p.coords.latitude, lon: p.coords.longitude };
    F.near = true; shown = PAGE;
    $('#btnNear').textContent = '📍 Yakınımdakiler'; $('#btnNear').classList.add('on');
    renderList();
  }, () => { $('#btnNear').textContent = '📍 Yakınımdakiler'; alert('Konum alınamadı. Konum iznini kontrol edin.'); }, { enableHighAccuracy: true, timeout: 12000 });
});
$('#btnFav').addEventListener('click', () => { F.fav = !F.fav; $('#btnFav').classList.toggle('on', F.fav); shown = PAGE; renderList(); });

$('#fab').addEventListener('click', () => openEdit(''));
$('#btnBackup').addEventListener('click', backup);
$('#btnDriveBackup').addEventListener('click', driveBackup);
$('#btnDriveRestore').addEventListener('click', driveRestore);
$('#btnDriveCfg').addEventListener('click', () => driveCfg(true));
$('#btnRestore').addEventListener('click', () => $('#fileRestore').click());
$('#fileRestore').addEventListener('change', e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });
$('#btnCsv').addEventListener('click', csvExport);
$('#btnReset').addEventListener('click', () => {
  if (confirm('Tüm düzenlemeler, eklenen bayiler, ziyaret notları ve favoriler silinecek. Orijinal Excel listesine dönülecek. Emin misiniz?')) {
    ov = { edits: {}, added: [], deleted: [], visits: {}, favs: [] };
    save(); shown = PAGE; mapDirty = true; renderList(); renderStats();
  }
});

/* tıklama delegasyonu: kart, favori, detay içi butonlar, sheet kapatma */
document.addEventListener('click', e => {
  const t = e.target;
  const closeId = t.dataset && t.dataset.close;
  if (closeId) { document.getElementById(closeId).classList.remove('on'); return; }
  if (t.dataset && t.dataset.fav) {
    e.stopPropagation();
    const id = t.dataset.fav, i = ov.favs.indexOf(id);
    if (i >= 0) ov.favs.splice(i, 1); else ov.favs.push(id);
    save(); t.classList.toggle('on');
    if (F.fav) renderList();
    return;
  }
  if (t.dataset && t.dataset.edit) { openEdit(t.dataset.edit); return; }
  if (t.dataset && t.dataset.gfile) { driveLoadFile(t.dataset.gfile); return; }
  if (t.dataset && t.dataset.karar) { const [k, id] = t.dataset.karar.split('|'); karar(k, id); return; }
  if (t.id === 'btnCreateInvite') { createInvite(); return; }
  if (t.id === 'btnGiris') {
    const v = ($('#girisTok').value || '').trim();
    const m = v.match(/davet=([A-Za-z0-9_-]+)/);
    const tok = m ? m[1] : v;
    if (!tok) { alert('Önce davet linkinizi yapıştırın.'); return; }
    TOKEN = tok; localStorage.setItem('mydealer_token', tok);
    t.textContent = 'Bağlanıyor…';
    syncData(false).then(ok => { if (!ok) renderList(); });
    return;
  }
  if (t.id === 'btnTekrar') { t.textContent = '↻ Deneniyor…'; syncData(false).then(ok => { if (!ok) renderList(); }); return; }
  if (t.dataset && t.dataset.copy) {
    navigator.clipboard.writeText(t.dataset.copy).then(() => { t.textContent = '✓ Kopyalandı'; setTimeout(() => t.textContent = '🔗 Linki Kopyala', 1600); })
      .catch(() => prompt('Linki elle kopyalayın:', t.dataset.copy));
    return;
  }
  if (t.dataset && t.dataset.revoke) {
    if (confirm('Bu davet iptal edilsin mi? Kişi artık listeye erişemez.')) {
      apiPost('revoke', { target: t.dataset.revoke }).then(renderInviteList).catch(e => alert('Olmadı: ' + e.message));
    }
    return;
  }
  if (t.dataset && t.dataset.pdim) { piv.dim = t.dataset.pdim; renderPivot(); return; }
  if (t.dataset && t.dataset.pcrumb !== undefined) {
    const i = +t.dataset.pcrumb;
    piv.path = i < 0 ? [] : piv.path.slice(0, i + 1);
    const used = new Set(piv.path.map(p => p.dim));
    piv.dim = PDIMS.find(d => !used.has(d[0]))[0];
    renderPivot(); return;
  }
  if (t.dataset && t.dataset.plist !== undefined) { pivotToList(t.dataset.plist); return; }
  if (t.closest && t.closest('.prow') && t.closest('.prow').dataset.pin) {
    piv.path.push({ dim: piv.dim, value: t.closest('.prow').dataset.pin });
    const used = new Set(piv.path.map(p => p.dim));
    piv.dim = (PDIMS.find(d => !used.has(d[0])) || PDIMS[0])[0];
    renderPivot(); return;
  }
  if (t.id === 'btnSaveEdit') { saveEdit(t.dataset.id); return; }
  if (t.dataset && t.dataset.visit) {
    const id = t.dataset.visit, n = $('#visNote').value.trim();
    if (!n) { alert('Önce not yazın.'); return; }
    ov.visits[id] = ov.visits[id] || [];
    ov.visits[id].push({ t: new Date().toISOString(), n });
    save(); openDetail(id); renderList();
    return;
  }
  if (t.dataset && t.dataset.delvis) {
    const [id, idx] = t.dataset.delvis.split('|');
    ov.visits[id].splice(+idx, 1); save(); openDetail(id); renderList();
    return;
  }
  if (t.dataset && t.dataset.del) {
    const id = t.dataset.del, b = getDealer(id);
    const soru = SRV && !isAdmin()
      ? `"${(b.tabela || b.unvan)}" için silme önerisi yöneticinin onayına gönderilsin mi?`
      : `"${(b.tabela || b.unvan)}" listeden çıkarılsın mı?`;
    if (!confirm(soru)) return;
    if (SRV) {
      apiPost('change', { type: 'delete', dealerId: id }).then(sonuc => {
        if (sonuc.sonuc === 'uygulandi') {
          SRV.dealers = SRV.dealers.filter(x => x.id !== id);
          $('#shDetail').classList.remove('on');
          shown = PAGE; mapDirty = true; renderList(); if (viewNow === 'map') buildMap();
        } else {
          $('#shDetail').classList.remove('on');
          alert('Silme önerisi yöneticinin onayına gönderildi. ✓');
        }
      }).catch(e => alert('Olmadı: ' + e.message));
      return;
    }
    ov.deleted.push(id); save();
    $('#shDetail').classList.remove('on');
    shown = PAGE; mapDirty = true; renderList(); if (viewNow === 'map') buildMap();
    return;
  }
  if (t.closest && !t.dataset.stop) {
    const card = t.closest('.bcard');
    if (card && !t.closest('a') && !t.closest('.fav')) openDetail(card.dataset.id);
  }
});
/* sheet dışına dokununca kapat */
document.querySelectorAll('.sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) sh.classList.remove('on'); }));

$('#btnSync').addEventListener('click', async () => {
  $('#btnSync').textContent = '…';
  await syncData(false);
  $('#btnSync').textContent = '⟳';
});
$('#btnPending').addEventListener('click', openPending);
$('#btnInvites').addEventListener('click', openInvites);
$('#btnMyPending').addEventListener('click', async () => { await syncData(true); openMyPending(); });

/* ---------- başlat ---------- */
renderList();
applyRoleUI();
if (TOKEN) syncData(true).then(ok => { if (!ok) renderList(); }); // çevrimiçi mod (başarısızsa giriş paneli)
/* ================= ana sayfa (dashboard) ================= */
const HDIMS = [['bolge', 'Bölge'], ['sehir', 'Şehir'], ['ilce', 'İlçe'],
               ['segment', 'Segment'], ['durum', 'Durum']];
const HFKEY = { bolge: 'bolge', sehir: 'sehir', ilce: 'ilce', segment: 'seg', durum: 'durum' };
const home = { dim: 'bolge', scope: '', stack: [] };

function hPush(keys, label) {
  home.stack.push({ keys: Object.keys(keys), label: label });
  Object.assign(F, keys);
  buildFilters(); applyFilters();
}
function hBack() {
  const e = home.stack.pop();
  if (e) e.keys.forEach(k => { F[k] = ''; });
  buildFilters(); applyFilters();
}
function hReset(keys, label) {
  home.stack = [];
  F.bolge = F.sehir = F.ilce = '';
  if (label) hPush(keys, label); else { buildFilters(); applyFilters(); }
}
let hmap = null, hlayer = null;

const hN = n => Number(n || 0).toLocaleString('tr-TR');
const hP = (a, b) => b ? (a * 100 / b).toFixed(1).replace('.', ',') : '0,0';
const hAktif = b => String(b.durum || '').toUpperCase().indexOf('KAPALI') < 0;
const hSegA = b => String(b.segment || '').toUpperCase().charAt(0) === 'A';
const hZiy = b => (ov.visits[b.id] || []).length > 0;

function hGroups() {
  const m = new Map();
  for (const b of filtered()) {
    const k = b[home.dim] || '(boş)';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}
function hScoped() {
  const f = filtered();
  return home.scope ? f.filter(b => (b[home.dim] || '(boş)') === home.scope) : f;
}
function hGoList(dim, value) {
  F.bolge = F.sehir = F.ilce = F.seg = '';
  if (dim === 'bolge') F.bolge = value === '(boş)' ? '' : value;
  if (dim === 'sehir') F.sehir = value === '(boş)' ? '' : value;
  if (dim === 'ilce') F.ilce = value === '(boş)' ? '' : value;
  if (dim === 'segment') F.seg = value === '(boş)' ? '' : value;
  if (dim === 'durum') F.durum = value === '(boş)' ? '' : value;
  buildFilters(); shown = PAGE; mapDirty = true;
  document.querySelector('nav button[data-v="list"]').click();
  renderList();
}

function renderHome() {
  if (!allDealers().length) {
    $('#hPivots').innerHTML = '';
    $('#hStats').innerHTML = '<div class="hempty">Bayi listesi yüklü değil. Liste sekmesinden yedeği geri yükleyin.</div>';
    $('#hDist').innerHTML = ''; $('#hQ').innerHTML = ''; $('#hMiss').innerHTML = ''; $('#hScope').innerHTML = '';
    return;
  }
  const gs = hGroups();
  if (home.scope && !gs.some(g => g[0] === home.scope)) home.scope = '';
  const dimLabel = (HDIMS.find(d => d[0] === home.dim) || HDIMS[0])[1];

  const _all = allDealers();
  const _uniq = k => [...new Set(_all.map(b => b[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
  fillSelect($('#hBolge'), _uniq('bolge'), F.bolge, 'Bölge');
  fillSelect($('#hSehir'), F.bolge
    ? [...new Set(_all.filter(b => b.bolge === F.bolge).map(b => b.sehir).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'))
    : _uniq('sehir'), F.sehir, 'Şehir');
  fillSelect($('#hIlce'), F.sehir
    ? [...new Set(_all.filter(b => b.sehir === F.sehir).map(b => b.ilce).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'))
    : [], F.ilce, F.sehir ? 'İlçe' : 'İlçe (önce şehir)');

  $('#hPivots').innerHTML = HDIMS.map(d =>
    `<button class="hp ${home.dim === d[0] ? 'on' : ''}" data-hdim="${d[0]}">${d[1]}</button>`).join('');

  $('#hScope').innerHTML = `<option value="">Tümü — ${hN(filtered().length)} bayi</option>` +
    gs.map(g => `<option value="${esc(g[0])}"${g[0] === home.scope ? ' selected' : ''}>${esc(g[0])} (${hN(g[1].length)})</option>`).join('');

  $('#hUpd').innerHTML = SRV
    ? 'Sunucu listesi<br>' + esc(String(SRV.updated || '').slice(0, 16))
    : 'Cihazdaki liste<br>' + hN(allDealers().length) + ' kayıt';

  const d = hScoped(), t = d.length;
  const akt = d.filter(hAktif).length, sga = d.filter(hSegA).length;
  const koo = d.filter(b => b.lat).length;
  const ziy = d.filter(hZiy).length;
  const tam = d.filter(b => b.adres && b.tel).length;
  const cards = [
    ['🏪', 'Toplam bayi', hN(t), '', 'var(--pri2)'],
    ['✅', 'Aktif', hN(akt), '%' + hP(akt, t), 'var(--acc)'],
    ['⭐', 'A segment', hN(sga), '%' + hP(sga, t), 'var(--segC)'],
    ['📍', 'Koordinatlı', hN(koo), '%' + hP(koo, t), 'var(--segB)'],
    ['🗓️', 'Ziyaret edilen', hN(ziy), '%' + hP(ziy, t), 'var(--segD)'],
    ['✔️', 'Eksiksiz', hN(tam), '%' + hP(tam, t), 'var(--pri2)']
  ];
  $('#hStats').innerHTML = cards.map(c =>
    `<div class="hs"><em>${c[0]}</em><div class="l">${c[1]}</div>
      <div class="v">${c[2]}</div><div class="p" style="color:${c[4]}">${c[3]}</div></div>`).join('');

  const lvl = F.ilce ? 2 : (home.stack.length ? 1 : 0);
  $('#hBack').hidden = home.stack.length === 0;
  $('#hCrumb').innerHTML = home.stack.map(s => esc(s.label)).join(' › ');

  if (lvl === 0) {
    $('#hDistTitle').textContent = dimLabel + ' seçin';
    $('#hDrill').innerHTML = gs.length
      ? '<table class="htab"><thead><tr><th>' + esc(dimLabel) +
        '</th><th>Bayi</th><th>Aktif</th><th>A seg.</th></tr></thead><tbody>' +
        gs.slice(0, 20).map(g => `<tr data-hgrp="${esc(g[0])}"><td>${esc(g[0])}</td>
          <td>${hN(g[1].length)}</td><td>${hN(g[1].filter(hAktif).length)}</td>
          <td>${hN(g[1].filter(hSegA).length)}</td></tr>`).join('') + '</tbody></table>'
      : '<div class="hempty">Bu kırılımda kayıt yok.</div>';

  } else if (lvl === 1) {
    $('#hDistTitle').textContent = 'İlçe seçin';
    const m = new Map();
    for (const b of d) {
      const s = b.sehir || '(boş)', i = b.ilce || '(boş)';
      const k = s + '|' + i;
      if (!m.has(k)) m.set(k, { s: s, i: i, arr: [] });
      m.get(k).arr.push(b);
    }
    const rows = [...m.values()].sort((x, y) => y.arr.length - x.arr.length);
    $('#hDrill').innerHTML = rows.length ? rows.map(r =>
      `<div class="hrow2" data-hilce="${esc(r.i)}" data-hsehir="${esc(r.s)}">
        <div class="n"><b>${esc(r.i)}</b><span>${esc(r.s)} · ${hN(r.arr.filter(hAktif).length)} aktif</span></div>
        <span class="c">${hN(r.arr.length)}</span><span class="go">›</span></div>`).join('')
      : '<div class="hempty">Bu kapsamda ilçe yok.</div>';

  } else {
    $('#hDistTitle').textContent = hN(d.length) + ' bayi';
    const list = d.slice(0, 60);
    $('#hDrill').innerHTML = (list.length ? list.map(b => {
      const th = telHref(b.tel);
      return `<div class="hrow2" data-hbayi="${esc(b.id)}">
        <div class="n"><b>${esc(b.tabela || b.unvan)}</b>
          <span>${esc([b.sehir, b.ilce, b.segment ? 'Segment ' + b.segment : ''].filter(Boolean).join(' · '))}</span></div>
        ${th ? `<a class="callq" href="${th}" data-stop>📞</a>` : ''}<span class="go">›</span></div>`;
    }).join('') : '<div class="hempty">Bu ilçede bayi yok.</div>') +
      (d.length > 60 ? `<div class="hempty">İlk 60 kayıt gösteriliyor · <b data-hall="1" style="color:var(--pri2)">tümünü listede aç</b></div>` : '');
  }

  $('#hQScope').textContent = home.scope || 'tüm liste';
  const kismi = d.filter(b => (!b.adres || !b.tel) && (b.adres || b.tel)).length;
  const bos = d.filter(b => !b.adres && !b.tel).length;
  const qs = [['Eksiksiz', tam, 'var(--acc)'], ['Eksik bilgi', kismi, 'var(--segC)'], ['Tamamlanmalı', bos, 'var(--warn)']];
  $('#hQ').innerHTML = qs.map(q =>
    `<div><div class="l">${q[0]}</div><div class="v">${hN(q[1])}</div>
      <div class="p" style="color:${q[2]};font-size:11.5px;font-weight:700">%${hP(q[1], t)}</div></div>`).join('');

  const miss = [['Telefon yok', d.filter(b => !b.tel).length, 'tel'],
                ['Adres yok', d.filter(b => !b.adres).length, 'adres'],
                ['Koordinat yok', d.filter(b => !b.lat).length, 'koord'],
                ['Segment yok', d.filter(b => !b.segment).length, 'segment'],
                ['Ziyaret notu yok', d.filter(b => !hZiy(b)).length, 'ziyaret']];
  $('#hMiss').innerHTML = miss.map(m =>
    `<div class="r"><span>${m[0]}</span><b style="color:${m[1] ? 'var(--warn)' : 'var(--mut)'}">${hN(m[1])}</b></div>`).join('');

  const acts = [['➕', 'Yeni bayi', 'add'], ['⚠️', 'Eksikleri gör', 'eksik'],
                ['🕓', 'Ziyaretsizler', 'ziyaretsiz'], ['⭐', 'Favoriler', 'fav'],
                ['📍', 'Yakınımdakiler', 'near'], ['📊', 'CSV indir', 'csv']];
  $('#hActs').innerHTML = acts.map(a => `<button class="ha" data-hact="${a[2]}"><em>${a[0]}</em>${a[1]}</button>`).join('');

  renderHomeMap(gs);
}

function renderHomeMap(gs) {
  if (typeof L === 'undefined') return;
  try {
    if (!hmap) {
      hmap = L.map('homeMap', { zoomControl: false, attributionControl: false }).setView([39.0, 34.5], 5);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(hmap);
    }
    if (hlayer) hmap.removeLayer(hlayer);
    hlayer = L.layerGroup().addTo(hmap);
    const pts = [];
    for (const [k, arr] of gs.slice(0, 40)) {
      const c = arr.filter(b => b.lat && b.lon);
      if (!c.length) continue;
      const la = c.reduce((s, b) => s + Number(b.lat), 0) / c.length;
      const lo = c.reduce((s, b) => s + Number(b.lon), 0) / c.length;
      const sz = Math.max(30, Math.min(54, 24 + Math.log2(arr.length + 1) * 5));
      const col = k === home.scope ? 'var(--warn)' : 'var(--pri2)';
      L.marker([la, lo], {
        icon: L.divIcon({
          className: '',
          html: `<div class="hbub" style="width:${sz}px;height:${sz}px;background:${col}">${arr.length}</div>`,
          iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2]
        })
      }).bindTooltip(k).on('click', () => { home.scope = k; renderHome(); }).addTo(hlayer);
      pts.push([la, lo]);
    }
    if (pts.length) hmap.fitBounds(pts, { padding: [26, 26], maxZoom: 9 });
    setTimeout(() => hmap.invalidateSize(), 80);
  } catch (e) {}
}

$('#hPivots').addEventListener('click', e => {
  const b = e.target.closest('[data-hdim]'); if (!b) return;
  home.dim = b.dataset.hdim; home.scope = ''; hReset({}, null);
});
$('#hBolge').addEventListener('change', e => {
  const v = e.target.value;
  hReset({ bolge: v }, v || null);
});
$('#hSehir').addEventListener('change', e => {
  const v = e.target.value;
  home.stack = home.stack.filter(s => s.keys.indexOf('bolge') >= 0);
  F.sehir = v; F.ilce = '';
  if (v) home.stack.push({ keys: ['sehir', 'ilce'], label: v });
  buildFilters(); applyFilters();
});
$('#hIlce').addEventListener('change', e => {
  const v = e.target.value;
  home.stack = home.stack.filter(s => s.keys.indexOf('ilce') < 0);
  F.ilce = v;
  if (v) home.stack.push({ keys: ['ilce'], label: v });
  buildFilters(); applyFilters();
});
$('#btnHome').addEventListener('click', () => document.querySelector('nav button[data-v="home"]').click());
$('#hScope').addEventListener('change', e => { home.scope = e.target.value; renderHome(); });
$('#hDrill').addEventListener('click', e => {
  if (e.target.closest('[data-stop]')) return;
  const grp = e.target.closest('[data-hgrp]');
  if (grp) {
    const k = HFKEY[home.dim], o = {};
    o[k] = grp.dataset.hgrp === '(boş)' ? '' : grp.dataset.hgrp;
    hPush(o, grp.dataset.hgrp);
    return;
  }
  const il = e.target.closest('[data-hilce]');
  if (il) { hPush({ sehir: il.dataset.hsehir, ilce: il.dataset.hilce },
                  il.dataset.hsehir + ' · ' + il.dataset.hilce); return; }
  const by = e.target.closest('[data-hbayi]');
  if (by) { openDetail(by.dataset.hbayi); return; }
  if (e.target.closest('[data-hall]')) {
    document.querySelector('nav button[data-v="list"]').click(); renderList();
  }
});
$('#hBack').addEventListener('click', hBack);
$('#hActs').addEventListener('click', e => {
  const b = e.target.closest('[data-hact]'); if (!b) return;
  const a = b.dataset.hact;
  if (a === 'add') { openEdit(''); return; }
  if (a === 'csv') { csvExport(); return; }
  F.eksik = F.ziyaretsiz = F.fav = false;
  if (a === 'eksik') F.eksik = true;
  if (a === 'ziyaretsiz') F.ziyaretsiz = true;
  if (a === 'fav') { F.fav = true; $('#btnFav').classList.add('on'); }
  buildFilters(); shown = PAGE; mapDirty = true;
  document.querySelector('nav button[data-v="list"]').click();
  if (a === 'near') { $('#btnNear').click(); return; }
  renderList();
});

renderHome();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
