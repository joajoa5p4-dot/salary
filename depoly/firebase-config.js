/* 이루다Bank — Firebase 설정 (공개되어도 안전한 웹 설정값. 보안은 Firestore 규칙 + 서버 API 가 담당) */
window.IRUDA_CONFIG = {
  /* true: 항상 Firebase / false: 항상 로컬(브라우저 저장소) / 'auto': 배포 사이트는 Firebase, Claude 미리보기는 로컬 */
  useFirebase: true,
  sdkVersion: '13.2.0',
  emailDomain: 'iruda.bank',          // 아이디 → 로그인용 이메일 변환 (예: soojung01 → soojung01@iruda.bank)
  apiBase: '/api/users',               // 계정 생성/비밀번호 변경/삭제를 처리하는 Vercel 서버 함수
  firebase: {
    apiKey: "AIzaSyC9Pj53Tp6O6nqBiGC1PTbZmDFap-IVRfs",
    authDomain: "cashcash-3cb24.firebaseapp.com",
    projectId: "cashcash-3cb24",
    storageBucket: "cashcash-3cb24.firebasestorage.app",
    messagingSenderId: "610897276087",
    appId: "1:610897276087:web:094044805055b0c994f132"
  }
};
