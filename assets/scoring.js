// Pure scoring rules (no DOM). Used by app.js and testable in the browser console.
(function (global) {
  // ระดับ: ต้องผ่านเกณฑ์ร้อยละตามองค์ประกอบที่กำหนด (ตารางร้อยละการผ่านเกณฑ์)
  var LEVELS = [
    { name: 'เริ่มต้นพัฒนา', req: { 1: 80, 2: 80 } },
    { name: 'ดี', req: { 1: 80, 2: 80, 3: 80, 5: 60 } },
    { name: 'ดีมาก', req: { 1: 80, 2: 80, 3: 80, 5: 70 } },
    { name: 'ดีเด่น', req: { 1: 80, 2: 80, 3: 80, 4: 80, 5: 80 } }
  ];
  var NOT_PASSED = 'ยังไม่ผ่านเกณฑ์';

  // Items that count: for a variant group (same number, e.g. ข้อ 3 Clinic / Non Clinic) only the chosen one.
  function activeItems(items, variants) {
    variants = variants || {};
    return items.filter(function (it) {
      if (!it.group) return true;
      var chosen = variants[it.group];
      if (!chosen) chosen = items.filter(function (x) { return x.group === it.group; })[0].id;
      return chosen === it.id;
    });
  }

  function passes(comp, threshold) {
    // score/max*100 >= threshold, without floating point error
    return comp.score * 100 >= threshold * comp.max;
  }

  // scores: { itemId: 0..3 }  (missing = not yet scored, counts as 0)
  function computePart1(part1, scores, variants) {
    var items = activeItems(part1.items, variants);
    var comps = part1.components.map(function (c) {
      var its = items.filter(function (it) { return it.component === c.no; });
      var score = 0, scored = 0;
      its.forEach(function (it) {
        var s = scores[it.id];
        if (s === 0 || s === 1 || s === 2 || s === 3) { score += s; scored++; }
      });
      var max = its.length * 3;
      return { no: c.no, title: c.title, count: its.length, scored: scored, score: score, max: max,
               pct: max ? score / max * 100 : 0,
               first: its.length ? its[0].no : null, last: its.length ? its[its.length - 1].no : null };
    });
    var byNo = {};
    comps.forEach(function (c) { byNo[c.no] = c; });
    var levels = LEVELS.map(function (L) {
      var ok = Object.keys(L.req).every(function (n) { return passes(byNo[n], L.req[n]); });
      return { name: L.name, req: L.req, ok: ok };
    });
    var level = NOT_PASSED;
    levels.forEach(function (L) { if (L.ok) level = L.name; });
    var total = comps.reduce(function (a, c) { return a + c.score; }, 0);
    var max = comps.reduce(function (a, c) { return a + c.max; }, 0);
    var scored = comps.reduce(function (a, c) { return a + c.scored; }, 0);
    return { comps: comps, total: total, max: max, pct: max ? total / max * 100 : 0,
             scored: scored, count: items.length, levels: levels, level: level };
  }

  // ----- Part 2 -----
  function docsOk(std, checks) {
    checks = checks || {};
    var n = std.docs.filter(function (_, i) { return checks[i]; }).length;
    return std.rule === 'all' ? n === std.docs.length : n >= 1;
  }

  // answers: { stdId: { checks: {idx: true} } }, unitType: 'nonPrimary' | 'primary'
  function computePart2(part2, answers, unitType) {
    unitType = unitType || 'nonPrimary';
    var all = [];
    part2.sections.forEach(function (s) { s.groups.forEach(function (g) { g.standards.forEach(function (st) {
      if (!st.branch || st.branch === unitType) all.push(st);
    }); }); });
    var status = {};
    all.forEach(function (st) {
      var a = answers[st.id] || {};
      var any = Object.keys(a.checks || {}).some(function (k) { return a.checks[k]; });
      status[st.id] = { ok: docsOk(st, a.checks), any: any };
    });
    // A "▪" standard with alternatives also needs at least one alternative ครบ
    all.forEach(function (st) {
      var alts = all.filter(function (x) { return x.altOf === st.id; });
      if (alts.length) {
        status[st.id].altOk = alts.some(function (x) { return status[x.id].ok; });
        status[st.id].ok = status[st.id].ok && status[st.id].altOk;
      }
    });
    // What counts toward the total: alternatives are folded into their parent; optional only when used
    var counted = all.filter(function (st) {
      if (st.altOf) return false;
      if (st.optional && !status[st.id].any) return false;
      return true;
    });
    var done = counted.filter(function (st) { return status[st.id].ok; }).length;
    return { status: status, counted: counted, done: done, total: counted.length };
  }

  global.Scoring = { LEVELS: LEVELS, NOT_PASSED: NOT_PASSED, activeItems: activeItems,
                     computePart1: computePart1, computePart2: computePart2, docsOk: docsOk };
})(window);
