/* 이루다Bank — 공용 데이터 계층 (직원 앱 / 관리자 페이지가 함께 사용)
   · 로컬 모드(Claude 미리보기): 브라우저 저장소를 "서버"처럼 사용합니다.
   · Firebase 모드(배포 사이트): firebase-backend.js 가 attachBackend() 로 붙어 Firestore/Auth 를 사용합니다.
   페이지는 항상 restore() → refresh() 로 최신 데이터를 조회한 뒤 화면을 그립니다. */
(function () {
  var KEY = 'irudabank.store.v1';
  var SKEY = 'irudabank.session.v1';
  var memStore = null, memSession = null;
  var FB = null, cache = null;   // FB: Firebase 백엔드, cache: Firebase 모드에서 마지막으로 조회한 데이터

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var LAW = [
    { id: 'l1', title: '기본급', body: '1주 40시간(35시간/32.5시간/30시간/22.5시간) 및 1주 만근에 따른 주휴수당(8시간/7시간/6.5시간/6시간/4.5시간 을 포함한 209시간 (183시간/170시간/157시간/118시간) 의 임금 (단, 단시간 근로자 등의 경우 해당 근로자의 소정근로시간 및 그에 따른 주휴수당 반영)' },
    { id: 'l2', title: '포괄 연장근로 수당', body: '매월 사전에 포괄적으로 1일 소정근로시간시간, 1주 소정근로시간을 초과 하여 근무하는 경우를 전제로 지급하는 수당\n산정식 : 포괄연장근로시간x 통상시급 x 1.5배\n※ 1일 소정근로시간이 8시간인 경우 1주 소정근로시간 40시간(주휴시간 포함 월 209시간) / 1일 소정근로시간이 7시간인 경우 1주 소정근로시간 35시간(주휴시간 포함 월 183시간) / 1일 소정근로시간이 6.5시간인 경우 1주 소정근로시간 32.5시간(주휴시간 포함 월 170시간) / 1일 소정근로 시간이 6시간인 경우 1주 소정근로시간 30시간(주휴시간 포함 월 157시간)/ 1일 소정근로시간이 4.5시간인 경우 1주 소정근로시간 22.5시간 (주휴시간 포함 월 118시간)\n※ 통상시급 = 통상임금 ÷ 주휴시간 포함 월 소정근로시간\n(여기서 통상임금은 기본급을 포함한 매월 고정적으로 지급되는 임금을 의미. 단, 각종 연장및휴일근로수당은 제외한다)' },
    { id: 'l3', title: '추가 연장근로 수당', body: '1일 소정근로시간, 1주 소정근로시간을 초과하여 근무하는 경우 지급하는 수당(포괄연장근시간을 초과하여 추가로 근무하는 경우 지급하는 것을 원칙으로 함. 다만, 호의적 차원에서 포괄연장근로시간과 무관하게 산정하여 지급할 수 있음.)\n산정식 : 추가연장근로시간 x 통상시급 x 1.5배(1주 실 근로시간이 1주 소정근로시간을 초과하지 않는 경우 가산하지 않는다.)' },
    { id: 'l4', title: '휴일 근로수당', body: '근로기준법 제55조의 휴일과 근로자의 날에 근무하는 경우 지급하는 수당\n산정식 : 휴일근로시간 x 통상시급 x 1.5배' },
    { id: 'l5', title: '직책 수당', body: '특정 직책을 수행하는 경우 지급하는 수당' },
    { id: 'l6', title: '기타 수당', body: '위 제수당을 제외하고 기타 특별한 사정에 따라 지급하는 수당 (교육비 등)' },
    { id: 'l7', title: '조퇴/지각/결근 차감', body: ' - 조퇴/지각 차감 = 통상시급 x 조퇴 또는 지각 시간\n - 결근 차감 = 월급여 ÷ 해당 월의 역상 일수 x 휴무일\n - 주휴수당 차감 = 통상시급 x 소정근로시간 x 개근하지 못한 주의 수\n(주휴수당은 1주 개근시 지급. 따라서 1주 개근하지 못한 경우 해당주의 주휴수당을 차감할 수 있음)' },
    { id: 'l8', title: '연차 수당', body: '연차휴가사용을 제한하지 않는 범위 내에서 지급되는 1일분의 휴가수당' },
    { id: 'l9', title: '추가 인센티브', body: '' },
    { id: 'l10', title: '기타 추가 공제', body: ' 회사가 직원을 대신해 지불한 식대, 정산된 보험료, 추징 또는 환급되는 세액, 가불금 등에 대하여 추가로 공제 또는 환급하는 내역.' },
    { id: 'l11', title: '임금 산정기간', body: ' 매월 초일부터~말일까지, 지급일  익월 5일 또는 25일\n(중도 입퇴사시 일할계산됨)' }
  ];

  var SEED_MONTH = { pay: {}, perf: {}, settle: {} };

  function seed() {
    var m = clone(SEED_MONTH);
    m.file = { name: '급여 양식.xlsx', b64: window.IRUDA_SEEDFILE || '' };
    m.uploadedAt = '2026.11.09';
    m.modifiedAt = '';
    m.log = ['26.11.09 (등록)'];
    return {
      v: 1,
      admin: { id: 'admin', pw: 'admin1234' },
      accounts: [],
      months: {},
      messages: {},
      law: clone(LAW),
      deductNote: ''
    };
  }

  function emptyStore() { return { v: 1, admin: { id: 'admin', pw: '' }, accounts: [], months: {}, messages: {}, law: [], deductNote: '' }; }
  function load() {
    if (FB) return clone(cache || emptyStore());   // Firebase 모드: 서버에서 조회한 최신본(메모리). 브라우저에 급여를 남기지 않음
    try {
      var raw = window.localStorage.getItem(KEY);
      if (raw) { var s = JSON.parse(raw); if (s && s.accounts && s.months && s.law) return s; }
    } catch (e) { /* 저장소 사용 불가 → 메모리 */ }
    if (!memStore) memStore = seed();
    return clone(memStore);
  }
  /* 서버(또는 로컬 저장소)에서 최신 데이터를 새로 조회 */
  function refresh() {
    if (FB) return FB.fetchAll().then(function (s) { cache = s; return clone(s); });
    return Promise.resolve(load());
  }
  /* 새로고침/페이지 이동 후 로그인 유지 확인 → { role: 'admin' | 'emp', account } | null */
  function restore() {
    if (FB) return FB.restore();
    var ses = getSession(); if (!ses) return Promise.resolve(null);
    if (ses.role === 'admin') return Promise.resolve({ role: 'admin', account: null });
    var a = load().accounts.filter(function (x) { return x.id === ses.id; })[0];
    return Promise.resolve(a ? { role: 'emp', account: a } : null);
  }
  /* 로그인 → { ok, role, account } | { ok:false, error:'AUTH'|'NETWORK'|'TOO_MANY' } */
  function login(role, id, pw) {
    if (FB) return FB.login(role, id, pw);
    var st = load(); id = String(id || '').trim();
    if (role === 'admin') {
      if (id === st.admin.id && pw === st.admin.pw) { setSession({ role: 'admin' }); return Promise.resolve({ ok: true, role: 'admin', account: null }); }
    } else {
      var u = st.accounts.filter(function (a) { return a.loginId.toLowerCase() === id.toLowerCase() && a.pw === pw; })[0];
      if (u) { setSession({ role: 'emp', id: u.id }); return Promise.resolve({ ok: true, role: 'emp', account: u }); }
    }
    return Promise.resolve({ ok: false, error: 'AUTH' });
  }
  function logout() { setSession(null); cache = null; return FB ? FB.logout() : Promise.resolve(); }
  /* 월별 원본 엑셀(base64) — Firebase 모드에서는 조각 문서를 모아서 반환 */
  function getFile(ym, month) {
    if (month && month.file && month.file.b64) return Promise.resolve(month.file.b64);
    if (FB) return FB.getFile(ym, month);
    var m = load().months[ym]; return Promise.resolve((m && m.file && m.file.b64) || '');
  }
  function attachBackend(b) { FB = b; api.mode = b.mode; }
  function defaultLaw() { return clone(LAW); }

  /* ---- "서버" 저장: 성공할 때만 기존 데이터를 교체한다 (실패 시 저장 전 시점 유지) ---- */
  function serverSave(store, opt) {
    opt = opt || {};
    if (FB) return FB.save(store, cache || emptyStore(), opt).then(function (saved) { cache = clone(saved); return clone(saved); });
    return sleep(900 + Math.random() * 500).then(function () {
      if (opt.simulateFail) throw new Error('NETWORK');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('OFFLINE');
      if (!store || !Array.isArray(store.accounts) || !store.months || !Array.isArray(store.law) || !store.admin || !store.admin.id) throw new Error('EMPTY_PAYLOAD');
      var prev = null;
      try { prev = JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) { prev = memStore; }
      if (prev && prev.accounts && prev.accounts.length > 0 && store.accounts.length === 0 && !opt.allowEmpty) throw new Error('EMPTY_PAYLOAD');
      var json = JSON.stringify(store);
      try { window.localStorage.setItem(KEY, json); } catch (e) { memStore = JSON.parse(json); }
      memStore = JSON.parse(json);
      return true;
    });
  }

  function getSession() {
    try { var r = window.sessionStorage.getItem(SKEY); if (r) return JSON.parse(r); } catch (e) { }
    return memSession;
  }
  function setSession(s) {
    memSession = s;
    try { if (s) window.sessionStorage.setItem(SKEY, JSON.stringify(s)); else window.sessionStorage.removeItem(SKEY); } catch (e) { }
  }

  /* ---- 표시용 헬퍼 ---- */
  function n(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function fmt(v) { v = Math.round(n(v)); return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US'); }
  function fmtH(v) { v = n(v); return (Math.round(v * 10) === v * 10) ? v.toFixed(1) : String(Math.round(v * 100) / 100); }
  function ymLabel(ym) { var p = ym.split('-'); return p[0] + '년 ' + p[1] + '월'; }
  function monthOnly(ym) { return String(parseInt(ym.split('-')[1], 10)) + '월'; }
  function shiftYm(ym, d) { var p = ym.split('-'); var t = (+p[0]) * 12 + (+p[1]) - 1 + d; var y = Math.floor(t / 12), m = t % 12 + 1; return y + '-' + (m < 10 ? '0' + m : m); }
  function hireLabel(h) { var p = String(h || '').split('.'); return p.length === 3 ? p[0] + '년 ' + p[1] + '월  ' + p[2] + '일' : String(h || ''); }
  function stamp() { var d = new Date(); var y = String(d.getFullYear()), m = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2); return { long: y + '.' + m + '.' + dd, short: y.slice(2) + '.' + m + '.' + dd }; }

  /* 직원 한 명 + 한 달치 화면용 값 계산 */
  function view(store, ym, name) {
    var M = store.months[ym];
    if (!M || !M.pay || (!M.pay[name] && !(M.perf && M.perf[name]))) return null;
    var p = (M.pay && M.pay[name]) || {}, f = (M.perf && M.perf[name]) || {}, s = (M.settle && M.settle[name]) || [];
    var extraRows = [['포괄 연장 근로수당', n(p.bulk)], ['추가 연장 근로수당', n(p.extra)], ['휴일 근로수당', n(p.holiday)], ['직책 수당', n(p.position)], ['기타 수당', n(p.etcAllow)], ['연차 수당', n(p.annual)], ['교육비', n(p.edu)]];
    var extraTotal = extraRows.reduce(function (a, r) { return a + r[1]; }, 0);
    var taxRows = [['갑근세', n(p.incomeTax), 0], ['주민세', n(p.localTax), 0], ['국민 연금', n(p.pension), 1], ['건강 보험', n(p.health), 1], ['장기 요양', n(p.care), 1], ['고용 보험', n(p.employ), 1], ['사업 소득공제', n(p.biz), 0], ['기타 공제', n(p.etcDeduct), 0], ['연말 정산', n(p.yearEnd), 0]];
    var tax = taxRows.reduce(function (a, r) { return a + r[1]; }, 0);
    var deductRows = [['조퇴/지각/결근/주휴', n(p.weeklyDeduct) + n(p.attendDeduct)], ['voc', n(f.voc)], ['정산서', n(f.settle)], ['대외 민원', n(f.outside)], ['이상 영업', n(f.abnormal)], ['출고가 차감', n(f.ship)], ['개통 취소', n(f.cancel)], ['인터넷 차감', n(f.internet)]];
    var deduct = deductRows.reduce(function (a, r) { return a + r[1]; }, 0);
    return { p: p, f: f, settle: s, base: n(p.base), extraRows: extraRows, extraTotal: extraTotal, incentive: n(p.incentive), promo: n(p.promo), taxRows: taxRows, tax: tax, deductRows: deductRows, deduct: deduct, net: n(p.net), totalPay: n(p.totalPay), totalDeduct: n(p.totalDeduct), settleSum: s.reduce(function (a, r) { return a + n(r.amount); }, 0) };
  }

  /* ---------- 엑셀(.xlsx) 읽기 : 외부 라이브러리 없이 ---------- */
  function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw'); var w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function unzip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('NOT_XLSX');
    var cnt = dv.getUint16(e + 10, true), p = dv.getUint32(e + 16, true), files = {};
    for (var i = 0; i < cnt; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      files[new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl))] = { method: method, csize: csize, off: off };
      p += 46 + nl + el + cl;
    }
    return {
      get: function (name) {
        var f = files[name]; if (!f) return Promise.resolve(null);
        var ln = dv.getUint16(f.off + 26, true), le = dv.getUint16(f.off + 28, true), st = f.off + 30 + ln + le;
        var data = u8.subarray(st, st + f.csize);
        return (f.method === 0 ? Promise.resolve(data) : inflateRaw(data)).then(function (r) { return new TextDecoder().decode(r); });
      }
    };
  }
  function colIdx(ref) { var m = /^([A-Z]+)/.exec(ref || 'A'); var s = m ? m[1] : 'A', c = 0; for (var i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64); return c - 1; }
  function parseXlsx(buf) {
    var dp = new DOMParser(); function X(s) { return dp.parseFromString(s, 'application/xml'); }
    var z = unzip(buf), ss = [], rmap = {}, out = {};
    return z.get('xl/workbook.xml').then(function (wbx) {
      if (!wbx) throw new Error('NOT_XLSX');
      return z.get('xl/_rels/workbook.xml.rels').then(function (rx) {
        Array.prototype.forEach.call(X(rx).getElementsByTagName('Relationship'), function (r) { rmap[r.getAttribute('Id')] = r.getAttribute('Target'); });
        return z.get('xl/sharedStrings.xml').then(function (sx) {
          if (sx) Array.prototype.forEach.call(X(sx).getElementsByTagName('si'), function (si) { ss.push(Array.prototype.map.call(si.getElementsByTagName('t'), function (t) { return t.textContent; }).join('')); });
          var sheets = Array.prototype.slice.call(X(wbx).getElementsByTagName('sheet'));
          return sheets.reduce(function (chain, s) {
            return chain.then(function () {
              var name = s.getAttribute('name'), rid = s.getAttribute('r:id'), t = rmap[rid] || '';
              t = t.replace(/^\/?(xl\/)?/, 'xl/');
              return z.get(t).then(function (xml) {
                if (!xml) return;
                var rows = [];
                Array.prototype.forEach.call(X(xml).getElementsByTagName('row'), function (r) {
                  var arr = [];
                  Array.prototype.forEach.call(r.getElementsByTagName('c'), function (c) {
                    var ty = c.getAttribute('t'), v = c.getElementsByTagName('v')[0], val = null;
                    if (ty === 's' && v) val = ss[+v.textContent];
                    else if (ty === 'inlineStr') val = Array.prototype.map.call(c.getElementsByTagName('t'), function (q) { return q.textContent; }).join('');
                    else if (ty === 'str' && v) val = v.textContent;
                    else if (v && v.textContent !== '') val = parseFloat(v.textContent);
                    arr[colIdx(c.getAttribute('r'))] = val;
                  });
                  rows[(+r.getAttribute('r')) - 1] = arr;
                });
                out[name] = rows.map(function (r) { return r || []; });
              });
            });
          }, Promise.resolve());
        });
      });
    }).then(function () { return out; });
  }

  var PAY = { '기본급': 'base', '포괄연장수당': 'bulk', '추가연장수당': 'extra', '휴일수당': 'holiday', '프로모션': 'promo', '직책수당': 'position', '기타수당': 'etcAllow', '연차수당': 'annual', '인센티브': 'incentive', '교육비': 'edu', '주휴차감': 'weeklyDeduct', '근태차감': 'attendDeduct', '갑근세': 'incomeTax', '주민세': 'localTax', '국민연금': 'pension', '건강보험': 'health', '장기요양': 'care', '고용보험': 'employ', '사업소득공제': 'biz', '추가공제': 'extraDeduct', '기타공제': 'etcDeduct', '연말정산': 'yearEnd', '포괄연장': 'hBulk', '추가연장': 'hExtra', '휴일근로': 'hHoliday', '연차': 'hAnnual', '지각': 'hLate', '조퇴': 'hEarly', '결근': 'hAbsent', '주휴차감#2': 'hWeekly', '임금총액': 'totalPay', '공제총액': 'totalDeduct', '실수령액': 'net' };
  var PERF = { '판매점': 'dept', '리베이트': 'rebate', '현금입금': 'cashIn', '추가지원금': 'extraSupport', '프리할부': 'free', '사은품': 'gift', 'VOC차감': 'voc', '정산서차감': 'settle', '매출소계': 'subtotal', '개취재지급': 'reissue', '대외차감': 'outside', '이상영업': 'abnormal', '출고가차감': 'ship', '개통취소': 'cancel', '인터넷차감': 'internet', '현금인센': 'cashInc', '프로모션': 'promo', '최종매출': 'finalSales', '최종인센티브': 'finalIncentive' };
  var SET = { '판매채널': 'channel', '분류': 'cat', '거래처': 'vendor', '일련번호': 'serial', '환수금액': 'amount', '기타메모': 'memo' };

  function headerIndex(row) {
    var seen = {}, idx = {};
    (row || []).forEach(function (h, i) {
      var k = String(h == null ? '' : h).replace(/\s+/g, ''); if (!k) return;
      seen[k] = (seen[k] || 0) + 1; idx[seen[k] > 1 ? k + '#' + seen[k] : k] = i;
    });
    return idx;
  }
  function pick(sheet, map, textKeys, accountNames, unmatched) {
    var rows = sheet || [], idx = headerIndex(rows[0]);
    if (idx['이름'] == null) return { error: true };
    var out = {}, order = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [], raw = row[idx['이름']];
      var nm = raw == null ? '' : String(raw).trim();
      if (!nm) continue;
      if (accountNames.indexOf(nm) < 0) { if (unmatched.indexOf(nm) < 0) unmatched.push(nm); continue; }  // 계정 이름과 정확히 일치하는 행만 반영
      var o = {};
      Object.keys(map).forEach(function (h) {
        if (idx[h] == null) return;
        var v = row[idx[h]];
        o[map[h]] = textKeys.indexOf(map[h]) >= 0 ? (v == null ? '' : String(v)) : n(v);
      });
      if (map === PERF) o.subtotal = n(o.rebate) + n(o.cashIn) - n(o.extraSupport) - n(o.gift) - n(o.voc) - n(o.settle);
      out[nm] = out[nm] || []; out[nm].push(o); order.push(nm);
    }
    return { rows: out };
  }

  /* 업로드 반영: mode 'new' = 신규 등록, 'edit' = 수정 업로드(해당 연월의 일치 직원 값을 덮어씀) */
  function applyUpload(store, ym, sheets, fileInfo, mode) {
    var names = store.accounts.map(function (a) { return a.name; });
    var unmatched = [];
    var hasAny = sheets['명세서'] || sheets['실적장표'] || sheets['정산서'];
    if (!hasAny) return { ok: false, error: '시트(명세서 / 실적장표 / 정산서)를 찾을 수 없습니다.' };
    var P = sheets['명세서'] ? pick(sheets['명세서'], PAY, [], names, unmatched) : null;
    var F = sheets['실적장표'] ? pick(sheets['실적장표'], PERF, ['dept'], names, unmatched) : null;
    var S = sheets['정산서'] ? pick(sheets['정산서'], SET, ['channel', 'cat', 'vendor', 'serial', 'memo'], names, unmatched) : null;
    if ((P && P.error) || (F && F.error) || (S && S.error)) return { ok: false, error: '시트 첫 행에 "이름" 열이 없습니다.' };
    var cur = store.months[ym];
    if (mode === 'new' && cur) return { ok: false, error: ym.replace('-', '년 ') + '월 자료가 이미 있습니다. 수정 업로드를 이용해 주세요.' };
    if (mode === 'edit' && !cur) return { ok: false, error: '수정할 자료가 없습니다. 먼저 업로드하기로 등록해 주세요.' };
    var M = mode === 'edit' ? cur : { pay: {}, perf: {}, settle: {}, log: [], uploadedAt: stamp().long, modifiedAt: '' };
    var matched = [];
    if (P) Object.keys(P.rows).forEach(function (k) { M.pay[k] = P.rows[k][P.rows[k].length - 1]; if (matched.indexOf(k) < 0) matched.push(k); });
    if (F) Object.keys(F.rows).forEach(function (k) { M.perf[k] = F.rows[k][F.rows[k].length - 1]; if (matched.indexOf(k) < 0) matched.push(k); });
    if (S) Object.keys(S.rows).forEach(function (k) { M.settle[k] = S.rows[k]; if (matched.indexOf(k) < 0) matched.push(k); });
    if (!matched.length) return { ok: false, error: '등록된 계정 이름과 일치하는 행이 없습니다.', unmatched: unmatched };
    var st = stamp();
    if (fileInfo) M.file = fileInfo;
    if (mode === 'edit') { M.modifiedAt = st.long; M.log.push(st.short + '(수정)'); } else { M.log = [st.short + ' (등록)']; }
    store.months[ym] = M;
    return { ok: true, matched: matched, unmatched: unmatched };
  }

  function bufToB64(buf) { var u8 = new Uint8Array(buf), s = '', i = 0; for (; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
  function download(name, b64) {
    try {
      var bin = atob(b64), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return downloadBlob(name, new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) { return Promise.resolve(false); }
  }

  /* ---------- 엑셀(.xlsx) 만들기 (압축 없는 zip) ---------- */
  var CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function xmlEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function buildXlsx(rows, sheetName) {
    var enc = new TextEncoder();
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="5" width="18" customWidth="1"/></cols><sheetData>' +
      rows.map(function (r, ri) { return '<row r="' + (ri + 1) + '">' + r.map(function (v, ci) { return '<c r="' + colName(ci) + (ri + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>'; }).join('') + '</row>'; }).join('') + '</sheetData></worksheet>';
    var files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xmlEsc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', sheet]
    ];
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = enc.encode(f[0]), data = enc.encode(f[1]), crc = crc32(data);
      var head = [0x50, 0x4b, 3, 4].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(head), name, data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2].concat(u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += head.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, p) { return a + p.length; }, 0);
    var end = new Uint8Array([0x50, 0x4b, 5, 6].concat(u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
    return new Blob(parts.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  /* 플랫폼 downloads 기능 우선 사용(저장 확인창), 없으면 일반 링크 다운로드. 결과: true | 'declined' | false */
  function downloadBlob(name, blob) {
    var viaCap = (window.claude && window.claude.use) ? Promise.resolve(window.claude.use('downloads')).catch(function () { return null; }) : Promise.resolve(null);
    return viaCap.then(function (dl) {
      if (!dl || !dl.save) return downloadAnchor(name, blob);
      return dl.save({ filename: name, data: blob }).then(function () { return true; }, function (e) {
        if (e && e.code === 'declined') return 'declined';
        return downloadAnchor(name, blob);
      });
    });
  }
  function downloadAnchor(name, blob) {
    try {
      var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000); return true;
    } catch (e) { return false; }
  }


  /* ---------- 급여명세서 PDF (1·2페이지를 한 파일로) ---------- */
  var _libs = {};
  function loadScript(src) {
    if (_libs[src]) return _libs[src];
    return (_libs[src] = new Promise(function (res, rej) {
      var el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = function () { delete _libs[src]; rej(new Error('LIB')); };
      document.head.appendChild(el);
    }));
  }
  function capturePage(url) {
    return new Promise(function (res, rej) {
      var fr = document.createElement('iframe');
      fr.setAttribute('aria-hidden', 'true');
      fr.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;visibility:hidden';
      var done = false, t0 = Date.now();
      function end(err, canvas) { if (done) return; done = true; try { fr.remove(); } catch (e) { } err ? rej(err) : res(canvas); }
      fr.onload = function () {
        (function poll() {
          if (done) return;
          var d, el;
          try { d = fr.contentDocument; el = d && d.querySelector('.cq .pp'); } catch (e) { return end(new Error('FRAME')); }
          var ready = d && d.body && d.body.getAttribute('data-ready');
          if (ready === 'err') return end(new Error('LOAD'));
          if (el && ready === '1') {
            var go = function () {
              window.html2canvas(d.querySelector('.cq'), { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: 794, height: 1123, windowWidth: 794, windowHeight: 1123 })
                .then(function (c) { end(null, c); }, function (e) { end(e || new Error('CAPTURE')); });
            };
            (d.fonts && d.fonts.ready ? d.fonts.ready : Promise.resolve()).then(function () { setTimeout(go, 250); });
            return;
          }
          if (Date.now() - t0 > 25000) return end(new Error('TIMEOUT'));
          setTimeout(poll, 150);
        })();
      };
      fr.src = url;
      document.body.appendChild(fr);
    });
  }
  function makePayslipPdf(ym) {
    return Promise.all([loadScript('./vendor/html2canvas.min.js'), loadScript('./vendor/jspdf.umd.min.js')]).then(function () {
      return capturePage('./Payslip.dc.html?ym=' + encodeURIComponent(ym));
    }).then(function (c1) {
      return capturePage('./PayslipLaw.dc.html').then(function (c2) {
        var J = window.jspdf.jsPDF, pdf = new J({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
        pdf.addImage(c1.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
        pdf.addPage();
        pdf.addImage(c2.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
        return pdf.output('blob');
      });
    });
  }

  /* ---------- 사원 계정 엑셀 내보내기 / 불러오기 ---------- */
  var ACCT_HEAD = ['이름', '입사일', '부서', '아이디', '비밀번호'];
  function accountsToRows(accounts) { return [ACCT_HEAD].concat(accounts.map(function (a) { return [a.name, a.hire, a.dept, a.loginId, a.pw]; })); }
  function cellText(v) { return v == null ? '' : (typeof v === 'number' ? String(v) : String(v).trim()); }
  function normHire(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) { var d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return d.getUTCFullYear() + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '.' + ('0' + d.getUTCDate()).slice(-2); }
    var m = /^(\d{4})[.\-\/ ]+(\d{1,2})[.\-\/ ]+(\d{1,2})/.exec(cellText(v));
    return m ? m[1] + '.' + ('0' + m[2]).slice(-2) + '.' + ('0' + m[3]).slice(-2) : '';
  }
  /* 이름이 같으면 정보를 수정하고, 없는 이름이면 새 계정으로 추가한다. (삭제는 하지 않음) */
  function importAccounts(draft, sheets) {
    var name = Object.keys(sheets)[0], rows = name ? sheets[name] : null;
    if (!rows || !rows.length) return { ok: false, error: '엑셀에서 데이터를 찾을 수 없습니다.' };
    var idx = headerIndex(rows[0]);
    var miss = ACCT_HEAD.filter(function (h) { return idx[h] == null; });
    if (miss.length) return { ok: false, error: '첫 행에 다음 열이 필요해요: ' + miss.join(', ') };
    var added = 0, updated = 0, skipped = [], seenIds = {};
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [], nm = cellText(row[idx['이름']]);
      var lid = cellText(row[idx['아이디']]), pw = cellText(row[idx['비밀번호']]), dept = cellText(row[idx['부서']]), hire = normHire(row[idx['입사일']]);
      if (!nm && !lid && !pw) continue;
      var why = '';
      var cur = draft.accounts.filter(function (a) { return a.name === nm; })[0];
      if (!nm) why = '이름 없음'; else if (!lid) why = '아이디 없음'; else if (!cur && !pw) why = '비밀번호 없음'; else if (!hire) why = '입사일 형식 오류';
      else if (!/^[A-Za-z0-9._-]{2,40}$/.test(lid)) why = '아이디는 영문/숫자/._- 만 가능';
      else if (pw && pw.length < 6) why = '비밀번호 6자 미만';
      lid = lid.toLowerCase();
      if (!why && (lid === String(draft.admin.id).toLowerCase() || draft.accounts.some(function (a) { return a.loginId.toLowerCase() === lid && a !== cur; }) || (seenIds[lid] && seenIds[lid] !== nm))) why = '아이디 중복';
      if (why) { skipped.push((nm || ('행 ' + (r + 1))) + ' (' + why + ')'); continue; }
      seenIds[lid] = nm;
      if (cur) { cur.hire = hire; cur.dept = dept || cur.dept; cur.loginId = lid; if (pw) cur.pw = pw; updated++; }
      else { draft.accounts.push({ id: 'a' + Date.now() + '_' + r, name: nm, hire: hire, dept: dept, loginId: lid, pw: pw }); added++; }
    }
    if (!added && !updated) return { ok: false, error: '반영할 수 있는 행이 없습니다.', skipped: skipped };
    return { ok: true, added: added, updated: updated, skipped: skipped };
  }

  /* ---------- 이미지 첨부: 브라우저에서 WebP 로 강제 변환·압축 후 Base64 (data:image/webp;base64,...) ----------
     사용: IRUDA.imageToWebp(file, { maxSize: 1280, quality: 0.8 }).then(function (dataUrl) { ... })
     WebP 로 변환되지 못하면(구형 브라우저) 원본을 저장하지 않고 오류를 돌려줍니다. */
  function imageToWebp(file, opt) {
    opt = opt || {};
    var maxSize = opt.maxSize || 1280, quality = opt.quality == null ? 0.8 : opt.quality;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) { reject(new Error('NOT_IMAGE')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var sc = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
          cv.toBlob(function (b) {
            if (!b || b.type !== 'image/webp') { reject(new Error('WEBP_UNSUPPORTED')); return; }
            var fr = new FileReader(); fr.onload = function () { resolve(String(fr.result)); }; fr.onerror = function () { reject(new Error('READ_FAIL')); }; fr.readAsDataURL(b);
          }, 'image/webp', quality);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('NOT_IMAGE')); };
      img.src = url;
    });
  }

  var api = { mode: 'local', attachBackend: attachBackend, refresh: refresh, restore: restore, login: login, logout: logout, getFile: getFile, defaultLaw: defaultLaw, imageToWebp: imageToWebp,
    buildXlsx: buildXlsx, makePayslipPdf: makePayslipPdf, downloadBlob: downloadBlob, accountsToRows: accountsToRows, importAccounts: importAccounts, clone: clone, seed: seed, load: load, serverSave: serverSave, getSession: getSession, setSession: setSession, fmt: fmt, fmtH: fmtH, ymLabel: ymLabel, monthOnly: monthOnly, shiftYm: shiftYm, hireLabel: hireLabel, stamp: stamp, view: view, parseXlsx: parseXlsx, applyUpload: applyUpload, bufToB64: bufToB64, download: download };
  window.IRUDA = api;
})();
