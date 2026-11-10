/* Vercel 서버 함수 — 계정 생성 · 정보/비밀번호 변경 · 삭제 · 관리자 계정 변경
   브라우저(클라이언트)에서는 다른 사람의 비밀번호를 바꿀 수 없으므로 Firebase Admin SDK 로 처리합니다.
   호출자는 반드시 로그인한 "관리자"(Firestore admins/{uid} 문서 보유)여야 합니다. */
const admin = require('firebase-admin');

const DOMAIN = process.env.IRUDA_EMAIL_DOMAIN || 'iruda.bank';
const ID_RE = /^[A-Za-z0-9._-]{2,40}$/;

function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
function toEmail(id) {
  const s = String(id || '').trim().toLowerCase();
  const hex = (t) => Array.from(t).map((c) => c.charCodeAt(0).toString(16)).join('');
  return (/^[a-z0-9._-]+$/.test(s) ? s : 'u' + hex(s)) + '@' + DOMAIN;
}
const bad = (res, status, code, message) => res.status(status).json({ code, message });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'METHOD', 'POST only');
  try {
    init();
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tok) return bad(res, 401, 'NO_TOKEN', '로그인이 필요합니다.');
    const caller = await admin.auth().verifyIdToken(tok);
    const isAdmin = (await admin.firestore().doc('admins/' + caller.uid).get()).exists;
    if (!isAdmin) return bad(res, 403, 'FORBIDDEN', '관리자만 사용할 수 있습니다.');

    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const auth = admin.auth();

    if (b.action === 'create') {
      if (!ID_RE.test(String(b.loginId || ''))) return bad(res, 400, 'BAD_ID', '아이디 형식이 올바르지 않습니다.');
      if (!b.password || String(b.password).length < 6) return bad(res, 400, 'WEAK_PW', '비밀번호는 6자 이상이어야 합니다.');
      const email = toEmail(b.loginId);
      try {   // 재시도해도 안전: 이미 만들어진 계정이면 비밀번호만 맞춰 uid 반환
        const u = await auth.getUserByEmail(email);
        await auth.updateUser(u.uid, { password: String(b.password) });
        return res.json({ uid: u.uid });
      } catch (e) {
        if (e.code !== 'auth/user-not-found') throw e;
        const u = await auth.createUser({ email, password: String(b.password) });
        return res.json({ uid: u.uid });
      }
    }
    if (b.action === 'update') {
      if (!b.uid) return bad(res, 400, 'BAD_REQ', 'uid 가 필요합니다.');
      const patch = {};
      if (b.loginId) { if (!ID_RE.test(String(b.loginId))) return bad(res, 400, 'BAD_ID', '아이디 형식이 올바르지 않습니다.'); patch.email = toEmail(b.loginId); }
      if (b.password) { if (String(b.password).length < 6) return bad(res, 400, 'WEAK_PW', '비밀번호는 6자 이상이어야 합니다.'); patch.password = String(b.password); }
      if (Object.keys(patch).length) await auth.updateUser(b.uid, patch);
      return res.json({ ok: true });
    }
    if (b.action === 'delete') {
      if (!b.uid || b.uid === caller.uid) return bad(res, 400, 'BAD_REQ', '삭제할 수 없는 계정입니다.');
      try { await auth.deleteUser(b.uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
      return res.json({ ok: true });
    }
    if (b.action === 'setAdmin') {   // 호출한 관리자 본인의 아이디/비밀번호 변경
      const patch = {};
      if (b.loginId) { if (!ID_RE.test(String(b.loginId))) return bad(res, 400, 'BAD_ID', '아이디 형식이 올바르지 않습니다.'); patch.email = toEmail(b.loginId); }
      if (b.password) { if (String(b.password).length < 6) return bad(res, 400, 'WEAK_PW', '비밀번호는 6자 이상이어야 합니다.'); patch.password = String(b.password); }
      if (Object.keys(patch).length) await auth.updateUser(caller.uid, patch);
      return res.json({ ok: true });
    }
    return bad(res, 400, 'BAD_ACTION', '알 수 없는 요청입니다.');
  } catch (e) {
    console.error(e);
    if (e && e.code === 'auth/email-already-exists') return bad(res, 409, 'DUP_LOGIN', '이미 사용 중인 아이디입니다.');
    if (e && /id-token|ID token/i.test(String(e.message))) return bad(res, 401, 'BAD_TOKEN', '다시 로그인해 주세요.');
    return bad(res, 500, 'SERVER', '서버 오류가 발생했습니다.');
  }
};
