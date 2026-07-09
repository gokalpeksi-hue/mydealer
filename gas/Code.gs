/**
 * MyDealer API — Google Apps Script web uygulaması.
 * Veri, hesabınızın Drive'ında tek JSON dosyasında durur: mydealer-veri.json
 * { users: [...], dealers: [...], pending: [...], updated }
 *
 * Uçlar (op): setup, data, seed, change, pending, decide, invite, invites, revoke
 * GET  ?op=data&token=...          → okuma uçları
 * POST gövde: {"op":"change", ...} → yazma uçları (content-type: text/plain — CORS ön uçuşunu önler)
 */

var DOSYA_ADI = 'mydealer-veri.json';

function veriDosyasi_() {
  var it = DriveApp.getFilesByName(DOSYA_ADI);
  if (it.hasNext()) return it.next();
  return DriveApp.createFile(DOSYA_ADI,
    JSON.stringify({ users: [], dealers: [], pending: [], updated: null }),
    'application/json');
}
function oku_() {
  try { return JSON.parse(veriDosyasi_().getBlob().getDataAsString() || '{}'); }
  catch (e) { return { users: [], dealers: [], pending: [], updated: null }; }
}
function yaz_(d) { veriDosyasi_().setContent(JSON.stringify(d)); }

function token_(n) {
  var harf = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var s = '';
  for (var i = 0; i < (n || 22); i++) s += harf.charAt(Math.floor(Math.random() * harf.length));
  return s;
}

function kullanici_(d, token) {
  var us = d.users || [];
  for (var i = 0; i < us.length; i++) {
    if (us[i].token === token && us[i].active !== false) return us[i];
  }
  return null;
}

function yetkide_(u, b) {
  if (u.role === 'admin') return true;
  var s = u.sehir || [], i = u.ilce || [];
  if (s.length && s.indexOf(b.sehir || '') < 0) return false;
  if (i.length && i.indexOf(b.ilce || '') < 0) return false;
  return true;
}

function uygula_(d, ch) {
  if (ch.type === 'add') {
    var var_ = false;
    for (var i = 0; i < d.dealers.length; i++) if (d.dealers[i].id === ch.dealerId) var_ = true;
    if (!var_) {
      var yeni = { id: ch.dealerId };
      for (var k in ch.fields) yeni[k] = ch.fields[k];
      d.dealers.push(yeni);
    }
  } else if (ch.type === 'delete') {
    d.dealers = d.dealers.filter(function (b) { return b.id !== ch.dealerId; });
  } else {
    for (var j = 0; j < d.dealers.length; j++) {
      if (d.dealers[j].id === ch.dealerId) {
        for (var k2 in ch.fields) d.dealers[j][k2] = ch.fields[k2];
      }
    }
  }
  d.updated = new Date().toISOString();
}

function islem_(p) {
  var d = oku_();

  // --- kurulum: kullanıcı deposu boşken admin token belirlenir ---
  if (p.op === 'setup') {
    if (d.users && d.users.length) return { error: 'zaten_kurulu' };
    var t = String(p.adminToken || '').trim() || token_();
    d.users = [{ token: t, name: 'Yönetici', role: 'admin', created: new Date().toISOString(), active: true }];
    yaz_(d);
    return { ok: true, adminToken: t };
  }

  var u = kullanici_(d, String(p.token || '').trim());
  if (!u) return { error: 'gecersiz_token' };

  if (p.op === 'data') {
    var dealers = d.dealers.filter(function (b) { return yetkide_(u, b); });
    var out = { ok: true, role: u.role, name: u.name, sehir: u.sehir || [], ilce: u.ilce || [], updated: d.updated, dealers: dealers };
    var pend = d.pending || [];
    if (u.role === 'admin') {
      out.pendingCount = pend.filter(function (x) { return x.status === 'pending'; }).length;
    } else {
      out.myPending = pend.filter(function (x) { return x.token === u.token; }).slice(-30)
        .map(function (x) { return { id: x.id, ts: x.ts, type: x.type, dealerAdi: x.dealerAdi, status: x.status }; });
    }
    return out;
  }

  if (p.op === 'seed') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    if (!p.dealers || !p.dealers.length) return { error: 'dealers_gerekli' };
    if (d.dealers.length && !p.force) return { error: 'veri_zaten_var', mevcut: d.dealers.length };
    d.dealers = p.dealers;
    d.updated = new Date().toISOString();
    yaz_(d);
    return { ok: true, adet: d.dealers.length };
  }

  if (p.op === 'change') {
    var type = p.type;
    if (['edit', 'add', 'delete'].indexOf(type) < 0) return { error: 'gecersiz_tur' };
    if (type !== 'add' && !p.dealerId) return { error: 'dealerId_gerekli' };
    if (type !== 'delete' && (typeof p.fields !== 'object' || !p.fields)) return { error: 'fields_gerekli' };

    var hedef = null, dealerAdi = '';
    if (type === 'add') {
      hedef = p.fields;
      dealerAdi = hedef.tabela || hedef.unvan || '(yeni bayi)';
      if (!yetkide_(u, hedef)) return { error: 'yetki_disi_bolge' };
    } else {
      for (var i2 = 0; i2 < d.dealers.length; i2++) if (d.dealers[i2].id === p.dealerId) hedef = d.dealers[i2];
      if (!hedef) return { error: 'bayi_yok' };
      if (!yetkide_(u, hedef)) return { error: 'yetki_disi_bolge' };
      dealerAdi = hedef.tabela || hedef.unvan || p.dealerId;
      if (type === 'edit' && u.role !== 'admin') {
        var yeni2 = {};
        for (var k3 in hedef) yeni2[k3] = hedef[k3];
        for (var k4 in p.fields) yeni2[k4] = p.fields[k4];
        if (!yetkide_(u, yeni2)) return { error: 'yetki_disi_bolge' };
      }
    }

    var ch = {
      id: 'c' + Date.now() + token_(4),
      ts: new Date().toISOString(),
      token: u.token, name: u.name,
      type: type,
      dealerId: type === 'add' ? 'y' + Date.now() : p.dealerId,
      fields: type === 'delete' ? undefined : p.fields,
      dealerAdi: dealerAdi, status: 'pending'
    };

    if (u.role === 'admin') {
      uygula_(d, ch);
      yaz_(d);
      return { ok: true, sonuc: 'uygulandi', dealerId: ch.dealerId };
    }
    d.pending = d.pending || [];
    d.pending.push(ch);
    yaz_(d);
    return { ok: true, sonuc: 'onaya_gonderildi', id: ch.id };
  }

  if (p.op === 'pending') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    var items = (d.pending || []).filter(function (x) { return x.status === 'pending'; }).map(function (x) {
      var mevcut = null;
      if (x.type !== 'add') for (var i3 = 0; i3 < d.dealers.length; i3++) if (d.dealers[i3].id === x.dealerId) mevcut = d.dealers[i3];
      var eski = null;
      if (mevcut && x.fields) {
        eski = {};
        for (var k5 in x.fields) eski[k5] = mevcut[k5] === undefined ? '' : mevcut[k5];
      }
      return { id: x.id, ts: x.ts, name: x.name, type: x.type, dealerId: x.dealerId, dealerAdi: x.dealerAdi, fields: x.fields, eski: eski };
    });
    return { ok: true, items: items };
  }

  if (p.op === 'decide') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    if (['onay', 'red'].indexOf(p.karar) < 0) return { error: 'gecersiz_karar' };
    var ch2 = null;
    (d.pending || []).forEach(function (x) { if (x.id === p.id && x.status === 'pending') ch2 = x; });
    if (!ch2) return { error: 'kayit_yok' };
    if (p.karar === 'onay') { uygula_(d, ch2); ch2.status = 'onaylandi'; }
    else ch2.status = 'reddedildi';
    ch2.kararTs = new Date().toISOString();
    yaz_(d);
    return { ok: true, sonuc: ch2.status };
  }

  if (p.op === 'invite') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    var name = String(p.name || '').trim();
    if (!name) return { error: 'isim_gerekli' };
    var yeni3 = {
      token: token_(16), name: name, role: 'editor',
      sehir: (p.sehir || []).filter(Boolean), ilce: (p.ilce || []).filter(Boolean),
      created: new Date().toISOString(), active: true
    };
    d.users.push(yeni3);
    yaz_(d);
    return { ok: true, token: yeni3.token, name: name, sehir: yeni3.sehir, ilce: yeni3.ilce };
  }

  if (p.op === 'invites') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    return {
      ok: true,
      users: d.users.filter(function (x) { return x.role !== 'admin'; }).map(function (x) {
        return { token: x.token, name: x.name, sehir: x.sehir || [], ilce: x.ilce || [], created: x.created, active: x.active !== false };
      })
    };
  }

  if (p.op === 'revoke') {
    if (u.role !== 'admin') return { error: 'yetki_yok' };
    var kisi = null;
    d.users.forEach(function (x) { if (x.token === p.target && x.role !== 'admin') kisi = x; });
    if (!kisi) return { error: 'kisi_yok' };
    kisi.active = false;
    yaz_(d);
    return { ok: true };
  }

  return { error: 'gecersiz_islem' };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try { return json_(islem_((e && e.parameter) || {})); }
  catch (err) { return json_({ error: 'sunucu: ' + String(err) }); }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(25000); // eşzamanlı yazmaları sıraya koy
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(islem_(p));
  } catch (err) {
    return json_({ error: 'sunucu: ' + String(err) });
  } finally {
    lock.releaseLock();
  }
}
