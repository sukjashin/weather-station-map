// 관측출장 지원 — 앱처럼 쓰기 위한 서비스 워커
// 화면 뼈대(HTML/CSS/JS/아이콘)만 저장해 두고, 주소 검색·날씨·지도 타일 같은 외부 API는 항상 네트워크로 보냅니다.
const CACHE = 'obs-trip-v2';
const SHELL = [
  './',
  './index.html',
  './saved.html',
  './styles.css',
  './script.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// 지도 라이브러리는 한 번 받아두면 오프라인에서도 화면이 깨지지 않습니다.
const CDN_HOSTS = ['unpkg.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 같은 사이트 파일: 네트워크 우선(수정사항이 바로 반영), 실패하면 저장본
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => {
          if (hit) return hit;
          // 화면 이동일 때만 앱 첫 화면으로 대신하고, 데이터 요청은 그대로 실패시킵니다.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        }))
    );
    return;
  }

  // 지도 라이브러리(CDN): 저장본 우선
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
  // 그 외(카카오 API, 날씨, 지도 타일)는 가로채지 않고 그대로 네트워크로 보냅니다.
});
