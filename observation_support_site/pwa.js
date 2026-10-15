// 홈 화면에 앱으로 설치하기 (index.html, saved.html 공용)
(() => {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker 등록 실패', e));
    });
  }

  const btn = document.getElementById('installBtn');
  if (!btn) return;

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isStandalone) return; // 이미 앱으로 실행 중이면 버튼을 보이지 않습니다.

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;

  const say = (msg) => {
    const t = document.getElementById('toast');
    if (!t) return alert(msg);
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 4500);
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    deferred = null;
  });

  // iOS Safari는 설치 팝업이 없어서 안내 문구로 대신합니다.
  if (isIOS) btn.hidden = false;

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.hidden = true;
    } else if (isIOS) {
      say('Safari 하단의 공유 버튼 → "홈 화면에 추가"를 누르면 앱 아이콘이 만들어집니다.');
    } else {
      say('브라우저 메뉴(⋮)에서 "앱 설치" 또는 "홈 화면에 추가"를 눌러주세요.');
    }
  });
})();
