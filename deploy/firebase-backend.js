/* 이루다Bank — Firebase(Auth + Firestore) 백엔드
   - 데이터는 컬렉션별 "개별 문서"로 저장합니다 (문서 1개 = 1MB 제한 방지):
       accounts/{uid}            직원 계정 정보
       credentials/{uid}         직원 비밀번호(관리자 표에 표시용, 관리자만 읽기/쓰기 가능). 실제 로그인 검증은 Firebase Auth 가 담당
       payroll/{YYYY-MM}_{uid}   직원 1명 × 1개월 (명세서/실적장표/정산서)
       messages/{YYYY-MM}_{uid}  개인 전달 메세지
       months/{YYYY-MM}          월별 업로드 정보 + 변경 로그
       files/{YYYY-MM}_{n}       원본 엑셀(base64) 조각 (조각당 ~700KB)
       law/{id}                  법률 근거 카드
       settings/public           PDF 1페이지 하단 문구
       admins/{uid}              관리자 표시 문서 (콘솔에서 직접 생성)
   - 사이트에 들어올 때마다 서버에서 최신 데이터를 새로 조회(getDocsFromServer)해서 화면을 그립니다.
   - 저장은 "바뀐 문서만" 쓰고, 어느 단계든 실패하면 저장 전 상태를 그대로 유지합니다. */
(function () {
  var I = window.IRUDA, C = window.IRUDA_CONFIG;
  if (!I || !C || !C.firebase) return;

  /* 미리보기 판별: iframe 안(Claude 디자인 캔버스) / claude 도메인 / http(s) 가 아닌 주소 → 로컬 모드.
     Vercel 등 실제 배포 사이트(최상위 창, 일반 도메인)에서만 Firebase 를 사용합니다. */
  var host = '', inFrame = false;
  try { host = (location && location.hostname) || ''; } catch (e) { }
  try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
  var preview = inFrame || !host || /claude|anthropic/i.test(host) || !/^https?:$/.test(location.protocol);
  var forceLocal = /[?&]local=1/.test(location.search || '');
  var use = C.useFirebase === true || (C.useFirebase === 'auto' && !preview);
  if (C.useFirebase !== true && forceLocal) use = false;
  if (!use) return;

  var CHUNK = 700000;           // base64 문자 수 (Firestore 문서 한도 1MiB 이하로 유지)
  var BATCH = 400;              // 배치 1회 최대 쓰기 수 (한도 500)
  var snap = {};                // 마지막으로 서버와 일치한 문서 스냅샷 (경로 → 정렬된 JSON)

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fail(code, msg) { var e = new Error(code); e.userMessage = msg || ''; return e; }
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  /* ---------- SDK 로드 (gstatic CDN, 필요 시점에 1회) ---------- */
  var sdkP = null;
  function defaultLoader() {
    var base = 'https://www.gstatic.com/firebasejs/' + C.sdkVersion + '/';
    return Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]).then(function (m) {
      var app = m[0].initializeApp(C.firebase);
      /* 로그인 상태를 브라우저 탭(세션)에만 유지 — 창/탭을 닫으면 자동로그인이 되지 않습니다. */
      return { A: m[1], F: m[2], auth: m[1].initializeAuth(app, { persistence: m[1].browserSessionPersistence }), db: m[2].getFirestore(app) };
    });
  }
  function init() {
    if (!sdkP) sdkP = (window.IRUDA_SDK_LOADER ? window.IRUDA_SDK_LOADER(C) : defaultLoader()).catch(function (e) { sdkP = null; throw fail('NETWORK'); });
    return sdkP;
  }

  /* ---------- 아이디 ↔ 이메일 ---------- */
  function hex(s) { var o = ''; for (var i = 0; i < s.length; i++) o += s.charCodeAt(i).toString(16); return o; }
  function toEmail(id) {
    var s = String(id || '').trim().toLowerCase();
    return (/^[a-z0-9._-]+$/.test(s) ? s : 'u' + hex(s)) + '@' + (C.emailDomain || 'iruda.bank');
  }

  /* ---------- 서버 함수(API) 호출: 계정 생성 · 비밀번호 변경 · 삭제 ---------- */
  function api(s, action, body) {
    var u = s.auth.currentUser;
    if (!u) return Promise.reject(fail('NOT_SIGNED_IN'));
    return u.getIdToken().then(function (tok) {
      return fetch(C.apiBase || '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(Object.assign({ action: action }, body)) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw fail(j && j.code ? j.code : 'API_' + r.status, j && j.message);
        return j;
      });
    }, function () { throw fail('NETWORK'); });
  }

  /* ---------- 권한 확인 ---------- */
  function roleOf(s, user) {
    var F = s.F;
    return F.getDocFromServer(F.doc(s.db, 'admins', user.uid)).then(function (a) {
      if (a.exists()) return { role: 'admin', account: null };
      return F.getDocFromServer(F.doc(s.db, 'accounts', user.uid)).then(function (d) {
        if (!d.exists()) return null;
        var x = d.data(); return { role: 'emp', account: { id: user.uid, uid: user.uid, name: x.name, hire: x.hire, dept: x.dept, loginId: x.loginId, pw: '' } };
      });
    });
  }
  function mapAuthErr(e) {
    var c = (e && e.code) || '', m = (e && e.message) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c + m)) return { ok: false, error: 'AUTH' };
    if (/too-many-requests/.test(c)) return { ok: false, error: 'TOO_MANY' };
    return { ok: false, error: 'NETWORK' };
  }

  /* ---------- 문서 ↔ 화면용 store 변환 ---------- */
  function toDocs(w) {
    var d = {}, uidByName = {};
    (w.accounts || []).forEach(function (a) {
      var uid = a.uid || a.id; if (!uid) return;
      uidByName[a.name] = uid;
      d['accounts/' + uid] = { name: a.name, hire: a.hire, dept: a.dept, loginId: a.loginId };
      if (a.pw) d['credentials/' + uid] = { pw: String(a.pw) };
    });
    (w.law || []).forEach(function (c, i) { d['law/' + c.id] = { title: c.title || '', body: c.body || '', order: i }; });
    d['settings/public'] = { deductNote: w.deductNote || '' };
    Object.keys(w.months || {}).forEach(function (ym) {
      var m = w.months[ym], names = {};
      d['months/' + ym] = { uploadedAt: m.uploadedAt || '', modifiedAt: m.modifiedAt || '', log: (m.log || []).slice(-30), fileName: (m.file && m.file.name) || '', fileChunks: m.fileChunks || 0 };
      ['pay', 'perf', 'settle'].forEach(function (k) { Object.keys(m[k] || {}).forEach(function (n) { names[n] = 1; }); });
      Object.keys(names).forEach(function (n) {
        var uid = uidByName[n]; if (!uid) return;
        var o = { ym: ym, uid: uid, name: n };
        if (m.pay && m.pay[n]) o.pay = m.pay[n];
        if (m.perf && m.perf[n]) o.perf = m.perf[n];
        if (m.settle && m.settle[n]) o.settle = m.settle[n];
        d['payroll/' + ym + '_' + uid] = o;
      });
    });
    Object.keys(w.messages || {}).forEach(function (ym) {
      Object.keys(w.messages[ym] || {}).forEach(function (n) {
        var t = w.messages[ym][n], uid = uidByName[n];
        if (uid && t && String(t).trim()) d['messages/' + ym + '_' + uid] = { ym: ym, uid: uid, name: n, text: String(t) };
      });
    });
    return d;
  }
  function stableMap(docs) { var o = {}; Object.keys(docs).forEach(function (p) { o[p] = stable(docs[p]); }); return o; }
  function newMonth() { return { pay: {}, perf: {}, settle: {}, uploadedAt: '', modifiedAt: '', log: [], fileChunks: 0 }; }

  /* ---------- 서버에서 최신 데이터 조회 ---------- */
  function fetchAll() {
    return init().then(function (s) {
      var u = s.auth.currentUser; if (!u) throw fail('NOT_SIGNED_IN');
      return roleOf(s, u).then(function (r) {
        if (!r) throw fail('NO_ROLE');
        return r.role === 'admin' ? fetchAdmin(s, u) : fetchEmp(s, r.account);
      });
    }).catch(function (e) { if (e && e.message && /^[A-Z_0-9]+$/.test(e.message)) throw e; throw fail('NETWORK'); });
  }
  function fetchAdmin(s, u) {
    var F = s.F;
    function all(n) { return F.getDocsFromServer(F.collection(s.db, n)); }
    return Promise.all([all('accounts'), all('months'), all('payroll'), all('messages'), all('law'), F.getDocFromServer(F.doc(s.db, 'settings', 'public')), all('credentials')]).then(function (r) {
      var pwByUid = {}; r[6].forEach(function (d) { pwByUid[d.id] = d.data().pw || ''; });
      var st = { v: 1, admin: { id: String(u.email || '').split('@')[0], pw: '' }, accounts: [], months: {}, messages: {}, law: [], deductNote: '' }, nameByUid = {};
      r[0].forEach(function (d) { var x = d.data(); st.accounts.push({ id: d.id, uid: d.id, name: x.name, hire: x.hire, dept: x.dept, loginId: x.loginId, pw: pwByUid[d.id] || '' }); nameByUid[d.id] = x.name; });
      st.accounts.sort(function (a, b) { return (a.hire || '').localeCompare(b.hire || '') || a.name.localeCompare(b.name); });
      r[1].forEach(function (d) { var x = d.data(), m = newMonth(); m.uploadedAt = x.uploadedAt || ''; m.modifiedAt = x.modifiedAt || ''; m.log = x.log || []; m.fileChunks = x.fileChunks || 0; if (x.fileName) m.file = { name: x.fileName, b64: '', stored: true }; st.months[d.id] = m; });
      r[2].forEach(function (d) {
        var x = d.data(), ym = x.ym, nm = nameByUid[x.uid] || x.name; if (!ym || !nm) return;
        var m = st.months[ym] || (st.months[ym] = newMonth());
        if (x.pay) m.pay[nm] = x.pay; if (x.perf) m.perf[nm] = x.perf; if (x.settle) m.settle[nm] = x.settle;
      });
      r[3].forEach(function (d) { var x = d.data(), nm = nameByUid[x.uid] || x.name; if (!x.ym || !nm) return; (st.messages[x.ym] = st.messages[x.ym] || {})[nm] = x.text; });
      r[4].forEach(function (d) { var x = d.data(); st.law.push({ id: d.id, title: x.title || '', body: x.body || '', order: x.order || 0 }); });
      st.law.sort(function (a, b) { return a.order - b.order; }); st.law.forEach(function (c) { delete c.order; });
      st.deductNote = r[5].exists() ? (r[5].data().deductNote || '') : '';
      snap = stableMap(toDocs(st));
      return st;
    });
  }
  function fetchEmp(s, me) {
    var F = s.F, uidQ = F.where('uid', '==', me.uid);
    return Promise.all([
      F.getDocsFromServer(F.collection(s.db, 'law')),
      F.getDocFromServer(F.doc(s.db, 'settings', 'public')),
      F.getDocsFromServer(F.query(F.collection(s.db, 'payroll'), uidQ)),
      F.getDocsFromServer(F.query(F.collection(s.db, 'messages'), uidQ))
    ]).then(function (r) {
      var st = { v: 1, admin: { id: '', pw: '' }, accounts: [me], months: {}, messages: {}, law: [], deductNote: '' };
      r[0].forEach(function (d) { var x = d.data(); st.law.push({ id: d.id, title: x.title || '', body: x.body || '', order: x.order || 0 }); });
      st.law.sort(function (a, b) { return a.order - b.order; }); st.law.forEach(function (c) { delete c.order; });
      st.deductNote = r[1].exists() ? (r[1].data().deductNote || '') : '';
      r[2].forEach(function (d) {
        var x = d.data(), m = st.months[x.ym] || (st.months[x.ym] = newMonth());
        if (x.pay) m.pay[me.name] = x.pay; if (x.perf) m.perf[me.name] = x.perf; if (x.settle) m.settle[me.name] = x.settle;
      });
      r[3].forEach(function (d) { var x = d.data(); (st.messages[x.ym] = st.messages[x.ym] || {})[me.name] = x.text; });
      snap = {};
      return st;
    });
  }

  /* ---------- 저장 ---------- */
  function assertWebp(obj) {
    var re = /data:image\/(?!webp)[a-z0-9.+-]+;base64,/i;
    if (re.test(JSON.stringify(obj, function (k, v) { return k === 'b64' ? undefined : v; }))) throw fail('NOT_WEBP');
  }
  function validate(next, prev, opt) {
    if (!next || !Array.isArray(next.accounts) || !next.months || !Array.isArray(next.law) || !next.admin || !next.admin.id) throw fail('EMPTY_PAYLOAD');
    if (prev && prev.accounts.length > 0 && next.accounts.length === 0 && !opt.allowEmpty) throw fail('EMPTY_PAYLOAD');
    if (prev && Object.keys(prev.months || {}).length > 0 && Object.keys(next.months).length === 0 && !opt.allowEmpty) throw fail('EMPTY_PAYLOAD');
    var seen = {}, pv = {}; (prev ? prev.accounts : []).forEach(function (a) { pv[a.id] = a; });
    next.accounts.forEach(function (a) {
      var e = toEmail(a.loginId);
      if (!a.name || !a.loginId) throw fail('EMPTY_PAYLOAD');
      if (seen[e] || e === toEmail(next.admin.id)) throw fail('DUP_LOGIN');
      seen[e] = 1;
      if (!a.uid && !a.pw) throw fail('NO_PW');
      if (a.pw && (!pv[a.id] || pv[a.id].pw !== a.pw) && String(a.pw).length < 6) throw fail('WEAK_PW');
    });
    if (next.admin.pw && String(next.admin.pw).length < 6) throw fail('WEAK_PW');
    assertWebp(next);
  }
  function authOps(s, w, prev) {
    var prevById = {}, jobs = [];
    (prev ? prev.accounts : []).forEach(function (a) { prevById[a.id] = a; });
    w.accounts.forEach(function (a) {
      if (!a.uid) {
        jobs.push(function () { return api(s, 'create', { loginId: a.loginId, password: a.pw }).then(function (r) { a.uid = r.uid; a.id = r.uid; }); });
      } else {
        var p = prevById[a.id], body = { uid: a.uid }, chg = false;
        if (p && p.loginId !== a.loginId) { body.loginId = a.loginId; chg = true; }
        if (a.pw && (!p || p.pw !== a.pw)) { body.password = a.pw; chg = true; }
        if (chg) jobs.push(function () { return api(s, 'update', body); });
      }
    });
    var keep = {}; w.accounts.forEach(function (a) { keep[a.id] = 1; });
    Object.keys(prevById).forEach(function (id) { if (!keep[id]) jobs.push(function () { return api(s, 'delete', { uid: prevById[id].uid || id }); }); });
    if (w.admin.pw || (prev && prev.admin.id !== w.admin.id)) {
      jobs.push(function () { return api(s, 'setAdmin', { loginId: w.admin.id, password: w.admin.pw || undefined }).then(function () { w.admin.pw = ''; }); });
    }
    return jobs.reduce(function (p, j) { return p.then(j); }, Promise.resolve());
  }
  function writeDocs(s, w, prev) {
    var F = s.F, ops = [];
    /* 새로 올린 원본 엑셀 → 조각 문서 */
    var files = {};
    Object.keys(w.months).forEach(function (ym) {
      var m = w.months[ym];
      if (m.file && m.file.b64) {
        var n = Math.ceil(m.file.b64.length / CHUNK), n0 = (prev && prev.months[ym] && prev.months[ym].fileChunks) || 0;
        for (var i = 0; i < n; i++) files['files/' + ym + '_' + i] = { ym: ym, i: i, n: n, data: m.file.b64.slice(i * CHUNK, (i + 1) * CHUNK) };
        for (var j = n; j < n0; j++) ops.push({ t: 'del', p: 'files/' + ym + '_' + j });
        m.fileChunks = n;
      }
    });
    /* 삭제된 월의 원본 엑셀 조각 문서 정리 */
    if (prev && prev.months) Object.keys(prev.months).forEach(function (ym) {
      if (w.months[ym]) return;
      var n0 = prev.months[ym].fileChunks || 0;
      for (var j = 0; j < n0; j++) ops.push({ t: 'del', p: 'files/' + ym + '_' + j });
    });
    var next = toDocs(w), sm = stableMap(next);
    Object.keys(files).forEach(function (p) { ops.push({ t: 'set', p: p, data: files[p] }); });
    Object.keys(next).forEach(function (p) { if (snap[p] !== sm[p]) ops.push({ t: 'set', p: p, data: next[p] }); });
    Object.keys(snap).forEach(function (p) { if (!(p in next)) ops.push({ t: 'del', p: p }); });
    var chain = Promise.resolve();
    for (var k = 0; k < ops.length; k += BATCH) (function (part) {
      chain = chain.then(function () {
        var b = F.writeBatch(s.db);
        part.forEach(function (o) { var ref = F.doc.apply(null, [s.db].concat(o.p.split('/'))); if (o.t === 'set') b.set(ref, o.data); else b.delete(ref); });
        return b.commit();
      });
    })(ops.slice(k, k + BATCH));
    return chain.then(function () { snap = sm; });
  }
  function save(next, prev, opt) {
    opt = opt || {};
    return init().then(function (s) {
      if (opt.simulateFail) throw fail('NETWORK');
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw fail('OFFLINE');
      validate(next, prev, opt);
      var w = clone(next);
      return authOps(s, w, prev).then(function () { return writeDocs(s, w, prev); }).then(function () {
        Object.keys(w.months).forEach(function (ym) { var m = w.months[ym]; if (m.file && m.file.b64) m.file = { name: m.file.name, b64: '', stored: true }; });
        return w;
      });
    }).catch(function (e) { if (e && e.message && /^[A-Z_0-9]+$/.test(e.message)) throw e; var n = fail('NETWORK'); n.detail = (e && (e.code || e.message)) || ''; throw n; });
  }

  function getFile(ym, m) {
    return init().then(function (s) {
      var F = s.F, n = (m && m.fileChunks) || 0, ps = [];
      if (!n) return '';
      for (var i = 0; i < n; i++) ps.push(F.getDocFromServer(F.doc(s.db, 'files', ym + '_' + i)));
      return Promise.all(ps).then(function (ds) { return ds.map(function (d) { return d.exists() ? d.data().data : ''; }).join(''); });
    });
  }

  I.attachBackend({
    mode: 'firebase',
    login: function (role, id, pw) {
      return init().then(function (s) {
        return s.A.signInWithEmailAndPassword(s.auth, toEmail(id), pw).then(function (cred) { return roleOf(s, cred.user); }).then(function (r) {
          if (!r || r.role !== role) return s.A.signOut(s.auth).then(function () { return { ok: false, error: 'AUTH' }; });
          return { ok: true, role: r.role, account: r.account };
        });
      }).catch(mapAuthErr);
    },
    restore: function () {
      return init().then(function (s) {
        return s.auth.authStateReady().then(function () { return s.auth.currentUser ? roleOf(s, s.auth.currentUser) : null; });
      });
    },
    logout: function () { return init().then(function (s) { return s.A.signOut(s.auth); }).catch(function () { }); },
    fetchAll: fetchAll,
    save: save,
    getFile: getFile
  });
})();
