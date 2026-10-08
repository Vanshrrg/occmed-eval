(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var P1 = window.PART1, P2 = window.PART2, S = window.Scoring;
  var DEMO = !window.supabase || !CFG.SUPABASE_URL || /YOUR-PROJECT/.test(CFG.SUPABASE_URL) || /YOUR-ANON/.test(CFG.SUPABASE_ANON_KEY);

  // state[part][itemId] = { data: {...}, updated_at, updated_by }
  var state = { p1: {}, p2: {} };
  var timers = {}, inflight = {};
  var userName = lsGet('evalUserName') || '';

  // ---------- small utils ----------
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function getData(part, id) { return (state[part][id] && state[part][id].data) || {}; }
  function key(part, id) { return part + '|' + id; }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return iso; }
  }
  function pct(n) { return (Math.round(n * 10) / 10).toLocaleString('th-TH') + '%'; }
  function safe(s) { return String(s).replace(/[^A-Za-z0-9-]/g, '_'); }
  var toastTimer;
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, isErr ? 6000 : 2500);
  }
  function setSync(s) {
    var e = $('#sync');
    e.className = 'sync ' + s;
    e.title = { ok: 'บันทึกแล้ว', saving: 'กำลังบันทึก…', err: 'บันทึกไม่สำเร็จ', live: 'เชื่อมต่อแบบเรียลไทม์' }[s] || '';
  }

  // ---------- backends ----------
  function LocalBackend() {
    var LS = 'evalDemoData';
    function all() { try { return JSON.parse(lsGet(LS) || '[]'); } catch (e) { return []; } }
    var sub = null;
    window.addEventListener('storage', function (e) { if (e.key === LS && sub) all().forEach(sub); });
    return {
      session: function () { return Promise.resolve({ email: 'demo' }); },
      signIn: function () { return Promise.resolve(); },
      signOut: function () { return Promise.resolve(); },
      load: function () { return Promise.resolve(all()); },
      save: function (row) {
        var rows = all().filter(function (r) { return !(r.part === row.part && r.item_id === row.item_id); });
        rows.push(row);
        lsSet(LS, JSON.stringify(rows));
        return Promise.resolve();
      },
      subscribe: function (cb) { sub = cb; setSync('ok'); }
    };
  }

  function SupaBackend() {
    var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    function unwrap(r) { if (r.error) throw r.error; return r.data; }
    return {
      session: function () {
        return sb.auth.getSession().then(function (r) { return r.data.session && r.data.session.user; });
      },
      signIn: function (email, password) {
        return sb.auth.signInWithPassword({ email: email, password: password }).then(unwrap);
      },
      signOut: function () { return sb.auth.signOut(); },
      load: function () { return sb.from('responses').select('*').then(unwrap); },
      save: function (row) { return sb.from('responses').upsert(row).then(unwrap); },
      subscribe: function (cb) {
        sb.channel('responses-live')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'responses' }, function (p) {
            if (p.new && p.new.item_id) cb(p.new);
          })
          .subscribe(function (status) {
            if (status === 'SUBSCRIBED') setSync('live');
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('err');
          });
      }
    };
  }

  var Backend = DEMO ? LocalBackend() : SupaBackend();

  // ---------- saving ----------
  function patch(part, id, changes, delay) {
    var cur = state[part][id] || { data: {} };
    state[part][id] = {
      data: Object.assign({}, cur.data, changes),
      updated_at: new Date().toISOString(),
      updated_by: userName
    };
    var k = key(part, id);
    clearTimeout(timers[k]);
    timers[k] = setTimeout(function () { delete timers[k]; flush(part, id); }, delay || 0);
    setSync('saving');
    afterChange(part, id);
  }

  function flush(part, id) {
    var k = key(part, id), s = state[part][id];
    inflight[k] = (inflight[k] || 0) + 1;
    Backend.save({ part: part, item_id: id, data: s.data, updated_at: s.updated_at, updated_by: s.updated_by })
      .then(function () { setSync(DEMO ? 'ok' : 'live'); })
      .catch(function (err) {
        setSync('err');
        toast('บันทึกไม่สำเร็จ: ' + (err.message || err), true);
      })
      .then(function () { inflight[k]--; });
  }

  function pendingSaves() {
    return Object.keys(timers).length + Object.keys(inflight).reduce(function (a, k) { return a + inflight[k]; }, 0);
  }

  function applyRemote(row) {
    var k = key(row.part, row.item_id);
    if (timers[k] || inflight[k]) return; // our own newer edit is about to be saved
    if (!state[row.part]) return;
    state[row.part][row.item_id] = { data: row.data || {}, updated_at: row.updated_at, updated_by: row.updated_by };
    refreshItem(row.part, row.item_id);
    afterChange(row.part, row.item_id);
  }

  // ---------- shared item widgets (ผู้รับผิดชอบ, หมายเหตุ, ไฟล์แนบ) ----------
  function buildCommon(part, id) {
    var wrap = el('div', { class: 'common' });
    var fields = el('div', { class: 'item-fields' });
    var owner = el('label', null, 'ผู้รับผิดชอบ');
    var oi = el('input', { type: 'text', 'data-f': 'owner', placeholder: 'ชื่อผู้รับผิดชอบ' });
    owner.appendChild(oi);
    var note = el('label', null, 'หมายเหตุ / รายละเอียดหลักฐาน');
    var ni = el('textarea', { rows: '2', 'data-f': 'note' });
    note.appendChild(ni);
    fields.appendChild(owner);
    fields.appendChild(note);
    [oi, ni].forEach(function (inp) {
      inp.addEventListener('input', function () {
        var c = {}; c[inp.getAttribute('data-f')] = inp.value;
        patch(part, id, c, 700);
      });
    });
    wrap.appendChild(fields);

    var links = el('div', { class: 'files' });
    links.appendChild(el('div', { class: 'files-head' }, '<span>ลิงก์หลักฐาน (Google Drive)</span>'));
    links.appendChild(el('ul', { class: 'file-list' }));
    var form = el('form', { class: 'link-form' });
    var url = el('input', { type: 'url', placeholder: 'วางลิงก์ Google Drive https://drive.google.com/…', required: '' });
    var name = el('input', { type: 'text', placeholder: 'ชื่อเอกสาร (ไม่บังคับ)' });
    form.appendChild(url);
    form.appendChild(name);
    form.appendChild(el('button', { type: 'submit', class: 'btn small' }, 'เพิ่มลิงก์'));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (addLink(part, id, url.value, name.value)) { url.value = ''; name.value = ''; }
    });
    links.appendChild(form);
    wrap.appendChild(links);
    wrap.appendChild(el('div', { class: 'item-meta' }));
    return wrap;
  }

  function refreshCommon(card, part, id) {
    var d = getData(part, id), s = state[part][id];
    $$('[data-f]', card).forEach(function (inp) {
      if (document.activeElement === inp) return; // don't clobber what someone is typing
      var v = d[inp.getAttribute('data-f')] || '';
      if (inp.value !== v) inp.value = v;
    });
    var list = $('.file-list', card);
    list.innerHTML = '';
    (d.links || []).forEach(function (f) {
      var li = el('li');
      li.appendChild(el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: f.name || f.url, title: f.url }));
      if (f.by) li.appendChild(el('span', { class: 'muted', text: ' · ' + f.by }));
      var del = el('button', { type: 'button', class: 'link-btn danger', title: 'ลบลิงก์', text: 'ลบ' });
      del.addEventListener('click', function () { removeLink(part, id, f); });
      li.appendChild(del);
      list.appendChild(li);
    });
    if (!(d.links || []).length) list.appendChild(el('li', { class: 'muted', text: 'ยังไม่มีลิงก์' }));
    $('.item-meta', card).textContent = s && s.updated_at ? 'แก้ไขล่าสุด ' + fmtTime(s.updated_at) + (s.updated_by ? ' โดย ' + s.updated_by : '') : '';
  }

  function addLink(part, id, url, name) {
    url = (url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('ลิงก์ไม่ถูกต้อง ต้องขึ้นต้นด้วย https://', true); return false; }
    if (!/(drive|docs)\.google\.com/i.test(url)) toast('หมายเหตุ: ลิงก์นี้ไม่ใช่ Google Drive แต่บันทึกไว้แล้ว');
    var link = { url: url, name: (name || '').trim(), at: new Date().toISOString(), by: userName };
    patch(part, id, { links: (getData(part, id).links || []).concat([link]) });
    return true;
  }

  function removeLink(part, id, f) {
    if (!confirm('ลบลิงก์ "' + (f.name || f.url) + '" ? (ไฟล์ใน Google Drive จะไม่ถูกลบ)')) return;
    patch(part, id, { links: (getData(part, id).links || []).filter(function (x) { return !(x.url === f.url && x.at === f.at); }) });
  }

  // ---------- Part 1 ----------
  function variants() { return getData('p1', '_meta').variants || {}; }

  function renderPart1() {
    var host = $('#p1-items'), toc = $('#p1-toc');
    var comp = 0, sec = null;
    var tocList = el('ol', { class: 'toc-list' });
    P1.items.forEach(function (it) {
      if (it.component !== comp) {
        comp = it.component;
        var c = P1.components[comp - 1];
        host.appendChild(el('h2', { class: 'comp-head', id: 'comp-' + comp },
          'องค์ประกอบที่ ' + comp + ' <span>' + c.title + '</span>'));
        var li = el('li', { 'data-comp': comp },
          '<a href="#comp-' + comp + '">องค์ประกอบที่ ' + comp + '</a><span class="toc-score"></span><div class="bar"><i></i></div>');
        tocList.appendChild(li);
        sec = null;
      }
      if (it.section && it.section !== sec) {
        sec = it.section;
        host.appendChild(el('h3', { class: 'sec-head', text: sec }));
      }
      host.appendChild(buildP1Card(it));
    });
    toc.appendChild(el('h4', { text: 'สารบัญ' }));
    toc.appendChild(tocList);
  }

  function buildP1Card(it) {
    var card = el('article', { class: 'card item', id: 'p1-' + it.id, 'data-id': it.id });
    var head = el('header', { class: 'item-head' });
    head.appendChild(el('span', { class: 'item-no' }, 'ข้อ ' + it.no + (it.star ? ' <span class="star" title="ให้คะแนนตามข้อมูลที่มีได้">★</span>' : '')));
    head.appendChild(el('span', { class: 'score-badge' }));
    card.appendChild(head);

    if (it.group) {
      var v = el('label', { class: 'variant' });
      var vr = el('input', { type: 'radio', name: 'variant-' + it.group, value: it.id });
      vr.addEventListener('change', function () {
        var vs = Object.assign({}, variants()); vs[it.group] = it.id;
        patch('p1', '_meta', { variants: vs });
      });
      v.appendChild(vr);
      v.appendChild(document.createTextNode(' ใช้ข้อ ' + it.no + ' แบบ "' + it.variantLabel + '" ในการคิดคะแนน'));
      card.appendChild(v);
    }

    card.appendChild(el('div', { class: 'item-title' }, it.title));
    var det = el('details', { class: 'guide' });
    det.appendChild(el('summary', null, 'แนวทางการพิจารณาตามเกณฑ์' + (it.evidence ? ' / หลักฐาน' : '')));
    det.appendChild(el('div', { class: 'rich' }, it.guideline));
    if (it.evidence) {
      det.appendChild(el('h5', { text: 'หลักฐานหรือเอกสารยืนยัน' }));
      det.appendChild(el('div', { class: 'rich' }, it.evidence));
    }
    card.appendChild(det);

    var fs = el('fieldset', { class: 'criteria' });
    fs.appendChild(el('legend', null, 'เกณฑ์การให้คะแนน — เลือกคะแนนที่ได้'));
    it.criteria.forEach(function (txt, n) {
      var lab = el('label', { class: 'crit' });
      var r = el('input', { type: 'radio', name: 'score-' + it.id, value: String(n) });
      r.addEventListener('change', function () { patch('p1', it.id, { score: n }); });
      lab.appendChild(r);
      lab.appendChild(el('span', { class: 'crit-n', text: String(n) }));
      lab.appendChild(el('span', { class: 'crit-t', text: txt }));
      fs.appendChild(lab);
    });
    var clr = el('button', { type: 'button', class: 'link-btn', text: 'ล้างคะแนน' });
    clr.addEventListener('click', function () { patch('p1', it.id, { score: null }); });
    fs.appendChild(clr);
    card.appendChild(fs);
    card.appendChild(buildCommon('p1', it.id));
    return card;
  }

  function refreshP1Card(it) {
    var card = document.getElementById('p1-' + it.id);
    var d = getData('p1', it.id);
    var has = d.score === 0 || d.score === 1 || d.score === 2 || d.score === 3;
    $$('input[name="score-' + it.id + '"]', card).forEach(function (r) {
      r.checked = has && Number(r.value) === d.score;
      r.parentNode.classList.toggle('on', r.checked);
    });
    var b = $('.score-badge', card);
    b.textContent = has ? d.score + ' / 3 คะแนน' : 'ยังไม่ให้คะแนน';
    b.className = 'score-badge' + (has ? ' s' + d.score : ' none');
    if (it.group) {
      var active = S.activeItems(P1.items, variants()).some(function (x) { return x.id === it.id; });
      $('.variant input', card).checked = active;
      card.classList.toggle('inactive', !active);
    }
    refreshCommon(card, 'p1', it.id);
  }

  function p1Scores() {
    var sc = {};
    P1.items.forEach(function (it) { sc[it.id] = getData('p1', it.id).score; });
    return sc;
  }

  function levelClass(name) {
    return { 'ดีเด่น': 'lv4', 'ดีมาก': 'lv3', 'ดี': 'lv2', 'เริ่มต้นพัฒนา': 'lv1' }[name] || 'lv0';
  }

  // Whole days from today (local midnight) to the deadline
  function daysLeft() {
    var p = (CFG.P1_DEADLINE || '2027-06-01').split('-').map(Number);
    var end = new Date(p[0], p[1] - 1, p[2]);
    var now = new Date(); now.setHours(0, 0, 0, 0);
    return { days: Math.round((end - now) / 86400000), date: end };
  }

  function renderCountdown() {
    var c = daysLeft();
    var dateTxt = c.date.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
    var cls = c.days < 0 ? 'over' : c.days <= 30 ? 'urgent' : c.days <= 90 ? 'soon' : '';
    var txt = c.days > 0 ? 'เหลืออีก <b>' + c.days.toLocaleString('th-TH') + '</b> วัน'
      : c.days === 0 ? '<b>ครบกำหนดวันนี้</b>'
      : 'เลยกำหนดมาแล้ว <b>' + (-c.days).toLocaleString('th-TH') + '</b> วัน';
    $('#countdown').className = 'countdown ' + cls;
    $('#countdown').innerHTML = '<span>⏳ กำหนดประเมินมาตรฐานฯ ' + dateTxt + '</span><span class="cd-days">' + txt + '</span>';
    return { cls: cls, html: '<span class="cd-chip ' + cls + '">⏳ ' + txt + '</span>' };
  }

  function refreshP1Summary() {
    var r = S.computePart1(P1, p1Scores(), variants());
    var cd = renderCountdown();
    var chips = r.comps.map(function (c) {
      return '<a class="chip" href="#comp-' + c.no + '">องค์ ' + c.no + ' <b>' + c.score + '/' + c.max + '</b> ' + pct(c.pct) + '</a>';
    }).join('');
    $('#scorebar').innerHTML =
      '<div class="sb-main"><span>คะแนนรวม <b>' + r.total + '</b> / ' + r.max + ' (' + pct(r.pct) + ')</span>' +
      '<span class="muted">ให้คะแนนแล้ว ' + r.scored + '/' + r.count + ' ข้อ</span>' +
      '<span class="level ' + levelClass(r.level) + '">ระดับ: ' + r.level + '</span>' + cd.html + '</div>' +
      '<div class="sb-chips">' + chips + '</div>';
    r.comps.forEach(function (c) {
      var li = $('#p1-toc li[data-comp="' + c.no + '"]');
      $('.toc-score', li).textContent = c.scored + '/' + c.count + ' ข้อ · ' + pct(c.pct);
      $('.bar i', li).style.width = Math.min(100, c.pct) + '%';
    });
    return r;
  }

  // ---------- Part 2 ----------
  function unitType() { return getData('p2', '_meta').unitType || 'nonPrimary'; }

  function eachStd(fn) {
    P2.sections.forEach(function (s) { s.groups.forEach(function (g) { g.standards.forEach(function (st) { fn(st, g, s); }); }); });
  }

  function renderPart2() {
    $('#p2-title').textContent = P2.title;
    var host = $('#p2-items');
    P2.sections.forEach(function (s) {
      host.appendChild(el('h2', { class: 'comp-head', id: 'p2s-' + s.no }, s.no + '. <span>' + s.title + '</span>'));
      s.groups.forEach(function (g) {
        host.appendChild(el('h3', { class: 'sec-head', text: g.no + ' ' + g.title }));
        g.standards.forEach(function (st) { host.appendChild(buildP2Card(st)); });
      });
    });
    var notes = $('#p2-notes');
    P2.notes.forEach(function (n) { notes.appendChild(el('li', { text: n })); });

    $$('[data-meta]').forEach(function (inp) {
      var ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' || inp.type === 'date' ? 'change' : 'input';
      inp.addEventListener(ev, function () {
        var c = {}; c[inp.getAttribute('data-meta')] = inp.type === 'checkbox' ? inp.checked : inp.value;
        patch('p2', '_meta', c, ev === 'input' ? 700 : 0);
      });
    });
  }

  function buildP2Card(st) {
    var card = el('article', { class: 'card std' + (st.sub ? ' sub' : ''), id: 'p2-' + safe(st.id), 'data-id': st.id });
    if (st.branch) card.setAttribute('data-branch', st.branch);
    var head = el('header', { class: 'item-head' });
    head.appendChild(el('span', { class: 'std-title' }, (st.sub ? '• ' : '▪ ') + st.title));
    head.appendChild(el('span', { class: 'status-badge' }));
    card.appendChild(head);
    if (st.detail) card.appendChild(el('p', { class: 'std-detail' }, st.detail));
    card.appendChild(el('p', { class: 'rule' },
      '* เอกสาร/หลักฐานที่ต้องแนบ' + (st.rule === 'atLeastOne' ? '<b>อย่างน้อย 1 รายการ</b>' : (st.docs.length > 1 ? '<b>ทุกรายการ</b>' : ''))));
    var ul = el('ul', { class: 'doclist' });
    st.docs.forEach(function (txt, i) {
      var li = el('li');
      var lab = el('label');
      var cb = el('input', { type: 'checkbox', 'data-doc': String(i) });
      cb.addEventListener('change', function () {
        var checks = Object.assign({}, getData('p2', st.id).checks);
        if (cb.checked) checks[i] = true; else delete checks[i];
        patch('p2', st.id, { checks: checks });
      });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, txt));
      li.appendChild(lab);
      ul.appendChild(li);
    });
    card.appendChild(ul);
    var hasAlts = false;
    eachStd(function (x) { if (x.altOf === st.id) hasAlts = true; });
    if (hasAlts) card.appendChild(el('p', { class: 'alt-note' }, 'และต้องมีหลักฐานคุณวุฒิของบุคลากร<b>อย่างน้อย 1 ประเภท</b>ด้านล่าง'));
    card.appendChild(buildCommon('p2', st.id));
    return card;
  }

  function refreshP2Card(st, result) {
    var card = document.getElementById('p2-' + safe(st.id));
    var d = getData('p2', st.id), checks = d.checks || {};
    $$('input[data-doc]', card).forEach(function (cb) { cb.checked = !!checks[cb.getAttribute('data-doc')]; });
    var stt = result.status[st.id], b = $('.status-badge', card);
    if (!stt) { b.textContent = ''; b.className = 'status-badge'; }
    else if (stt.ok) { b.textContent = 'ครบ'; b.className = 'status-badge ok'; }
    else if (st.optional && !stt.any) { b.textContent = 'ไม่มี (ถ้ามี)'; b.className = 'status-badge na'; }
    else if (st.altOf) { b.textContent = stt.any ? 'ไม่ครบ' : 'ไม่ได้เลือก'; b.className = 'status-badge ' + (stt.any ? 'bad' : 'na'); }
    else { b.textContent = 'ไม่ครบ'; b.className = 'status-badge bad'; }
    refreshCommon(card, 'p2', st.id);
  }

  function refreshP2Meta() {
    var m = getData('p2', '_meta');
    $$('[data-meta]').forEach(function (inp) {
      if (document.activeElement === inp) return;
      var k = inp.getAttribute('data-meta');
      if (inp.type === 'checkbox') inp.checked = !!m[k];
      else if (inp.tagName === 'SELECT') inp.value = m[k] || 'nonPrimary';
      else if (inp.value !== (m[k] || '')) inp.value = m[k] || '';
    });
    var ut = unitType();
    $$('#p2-items [data-branch]').forEach(function (c) { c.hidden = c.getAttribute('data-branch') !== ut; });
  }

  function refreshP2Summary() {
    var r = S.computePart2(P2, p2Answers(), unitType());
    eachStd(function (st) { refreshP2Card(st, r); });
    $('#p2-bar').innerHTML = '<div class="sb-main"><span>มาตรฐานที่หลักฐานครบ <b>' + r.done + '</b> / ' + r.total + '</span>' +
      '<span class="level ' + (r.done === r.total ? 'lv4' : 'lv0') + '">' + (r.done === r.total ? 'ครบทุกข้อ' : 'ยังไม่ครบ ' + (r.total - r.done) + ' ข้อ') + '</span></div>';
    return r;
  }

  function p2Answers() {
    var a = {};
    eachStd(function (st) { a[st.id] = getData('p2', st.id); });
    return a;
  }

  // ---------- Summary tab ----------
  function renderSummary() {
    var r = S.computePart1(P1, p1Scores(), variants());
    var html = '<section class="panel"><h2>สรุปผลส่วนที่ 1 ประเมินมาตรฐานการจัดบริการอาชีวอนามัยและเวชกรรมสิ่งแวดล้อม</h2>';
    html += '<div class="big-level ' + levelClass(r.level) + '">ระดับ: ' + r.level + '</div>';
    html += '<div class="countdown ' + renderCountdown().cls + '">' + $('#countdown').innerHTML + '</div>';
    html += '<p>คะแนนรวม <b>' + r.total + '</b> / ' + r.max + ' (' + pct(r.pct) + ') · ให้คะแนนแล้ว ' + r.scored + '/' + r.count + ' ข้อ</p>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>องค์ประกอบ</th><th>ข้อ</th><th>คะแนนที่ได้</th><th>เต็ม</th><th>ร้อยละ</th></tr></thead><tbody>';
    r.comps.forEach(function (c) {
      html += '<tr><td class="l">องค์ประกอบที่ ' + c.no + ' ' + c.title + '</td><td>' + c.first + '–' + c.last +
        '</td><td>' + c.score + '</td><td>' + c.max + '</td><td><b>' + pct(c.pct) + '</b></td></tr>';
    });
    html += '<tr class="total"><td class="l">รวม</td><td>' + r.count + ' ข้อ</td><td>' + r.total + '</td><td>' + r.max + '</td><td>' + pct(r.pct) + '</td></tr>';
    html += '</tbody></table></div>';

    html += '<h3>ตารางร้อยละการผ่านเกณฑ์</h3><div class="tbl-wrap"><table class="tbl pass"><thead><tr><th>องค์ประกอบ</th>';
    r.levels.forEach(function (L) { html += '<th class="' + (L.ok ? 'hit' : '') + '">' + L.name + (L.ok ? ' ✓' : '') + '</th>'; });
    html += '</tr></thead><tbody>';
    r.comps.forEach(function (c) {
      html += '<tr><td class="l">องค์ประกอบที่ ' + c.no + ' <span class="muted">(' + pct(c.pct) + ')</span></td>';
      r.levels.forEach(function (L) {
        var need = L.req[c.no];
        if (!need) { html += '<td class="muted">-</td>'; return; }
        var ok = c.score * 100 >= need * c.max;
        html += '<td class="' + (ok ? 'yes' : 'no') + '">ผ่าน ' + need + ' % ' + (ok ? '✓' : '✗') + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<details class="levels-explain"><summary>การแบ่งระดับภายหลังการประเมิน</summary><ul>' +
      '<li><b>เริ่มต้นพัฒนา</b> คะแนนผ่านองค์ประกอบที่ 1-2 ร้อยละ 80</li>' +
      '<li><b>ดี</b> คะแนนผ่านองค์ประกอบที่ 1-3 ร้อยละ 80 และคะแนนผ่านองค์ประกอบที่ 5 ร้อยละ 60</li>' +
      '<li><b>ดีมาก</b> คะแนนผ่านองค์ประกอบที่ 1-3 ร้อยละ 80 และคะแนนผ่านองค์ประกอบที่ 5 ร้อยละ 70</li>' +
      '<li><b>ดีเด่น</b> คะแนนผ่านองค์ประกอบที่ 1-5 ร้อยละ 80 ขึ้นไป</li></ul></details>';

    var active = S.activeItems(P1.items, variants());
    var todo = active.filter(function (it) { var s = getData('p1', it.id).score; return !(s === 0 || s === 1 || s === 2 || s === 3); });
    var noOwner = active.filter(function (it) { return !getData('p1', it.id).owner; });
    html += listLinks('ข้อที่ยังไม่ให้คะแนน', todo, 'p1');
    html += listLinks('ข้อที่ยังไม่ระบุผู้รับผิดชอบ', noOwner, 'p1');
    html += '</section>';

    var r2 = S.computePart2(P2, p2Answers(), unitType());
    html += '<section class="panel"><h2>สรุปผลส่วนที่ 2 ขึ้นทะเบียนคลินิก (แบบ ม25ว3-5)</h2>';
    html += '<div class="big-level ' + (r2.done === r2.total ? 'lv4' : 'lv0') + '">หลักฐานครบ ' + r2.done + ' / ' + r2.total + ' มาตรฐาน</div>';
    html += '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>มาตรฐาน</th><th>สถานะ</th><th>ผู้รับผิดชอบ</th><th>ลิงก์</th></tr></thead><tbody>';
    r2.counted.forEach(function (st) {
      var g = '';
      eachStd(function (x, gr) { if (x.id === st.id) g = gr.no; });
      var d = getData('p2', st.id), ok = r2.status[st.id].ok;
      html += '<tr><td class="l"><a href="#p2-' + safe(st.id) + '" data-goto="p2">' + g + ' ' + st.title.replace(/<[^>]+>/g, '') + '</a></td>' +
        '<td class="' + (ok ? 'yes' : 'no') + '">' + (ok ? 'ครบ' : 'ไม่ครบ') + '</td><td>' + esc(d.owner || '-') + '</td><td>' + ((d.links || []).length) + '</td></tr>';
    });
    html += '</tbody></table></div></section>';
    $('#summary').innerHTML = html;
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function listLinks(title, items, tab) {
    if (!items.length) return '<p class="ok-text">✓ ' + title.replace('ที่ยังไม่', 'ครบ: ไม่มีข้อที่ยังไม่') + '</p>';
    return '<h4>' + title + ' (' + items.length + ')</h4><p class="link-list">' + items.map(function (it) {
      return '<a href="#p1-' + it.id + '" data-goto="' + tab + '">ข้อ ' + it.no + (it.variantLabel ? ' (' + it.variantLabel + ')' : '') + '</a>';
    }).join(' ') + '</p>';
  }

  // ---------- refresh orchestration ----------
  function refreshItem(part, id) {
    if (part === 'p1') {
      if (id === '_meta') P1.items.forEach(function (it) { if (it.group) refreshP1Card(it); });
      else { var it = P1.items.filter(function (x) { return x.id === id; })[0]; if (it) refreshP1Card(it); }
    } else if (id === '_meta') refreshP2Meta();
  }

  var summaryTimer;
  function afterChange(part, id) {
    if (part === 'p1') {
      refreshItem(part, id);
      refreshP1Summary();
    } else {
      if (id === '_meta') refreshP2Meta();
      refreshP2Summary();
    }
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(function () { if (!$('#tab-sum').hidden) renderSummary(); }, 100);
  }

  function refreshAll() {
    P1.items.forEach(refreshP1Card);
    refreshP1Summary();
    refreshP2Meta();
    refreshP2Summary();
    renderSummary();
  }

  // ---------- tabs ----------
  function showTab(name) {
    $$('[role=tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === name)); });
    $$('.tab-panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
    if (name === 'sum') renderSummary();
    lsSet('evalTab', name);
  }

  // ---------- boot ----------
  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#demo-banner').hidden = !DEMO;
    $('#who').textContent = userName ? 'ผู้ใช้: ' + userName : '';
    setSync('saving');
    return Backend.load().then(function (rows) {
      rows.forEach(function (row) {
        if (state[row.part]) state[row.part][row.item_id] = { data: row.data || {}, updated_at: row.updated_at, updated_by: row.updated_by };
      });
      refreshAll();
      Backend.subscribe(applyRemote);
      setSync(DEMO ? 'ok' : 'live');
    }).catch(function (err) {
      setSync('err');
      toast('โหลดข้อมูลไม่สำเร็จ: ' + (err.message || err), true);
    });
  }

  function init() {
    $$('[data-hospital]').forEach(function (e) { e.textContent = CFG.HOSPITAL_NAME || ''; });
    renderPart1();
    renderPart2();

    $$('[role=tab]').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
    showTab(lsGet('evalTab') || 'p1');
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-goto]');
      if (!a) return;
      e.preventDefault();
      showTab(a.getAttribute('data-goto'));
      var t = document.getElementById(a.getAttribute('href').slice(1));
      if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(function () { t.classList.remove('flash'); }, 1600); }
    });

    $('#btn-print').addEventListener('click', function () { window.print(); });
    window.addEventListener('beforeprint', function () { $$('details').forEach(function (d) { d.open = true; }); });
    $('#who').addEventListener('click', function () {
      var n = prompt('ชื่อของคุณ (แสดงว่าใครแก้ไข)', userName);
      if (n && n.trim()) { userName = n.trim(); lsSet('evalUserName', userName); $('#who').textContent = 'ผู้ใช้: ' + userName; }
    });
    $('#btn-logout').addEventListener('click', function () {
      Backend.signOut().then(function () { location.reload(); });
    });
    window.addEventListener('beforeunload', function (e) {
      if (pendingSaves()) { e.preventDefault(); e.returnValue = ''; }
    });

    $('#login-name').value = userName;
    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      $('#login-error').textContent = '';
      userName = $('#login-name').value.trim();
      lsSet('evalUserName', userName);
      Backend.signIn($('#login-email').value.trim(), $('#login-pass').value)
        .then(start)
        .catch(function (err) { $('#login-error').textContent = 'เข้าสู่ระบบไม่สำเร็จ: ' + (err.message || err); });
    });

    if (DEMO) {
      if (!userName) { userName = 'ผู้ทดลอง'; }
      start();
      return;
    }
    Backend.session().then(function (user) {
      if (user) {
        if (!userName) userName = user.email;
        start();
      } else {
        $('#login').hidden = false;
      }
    });
  }

  init();
})();
