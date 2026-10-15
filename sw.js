// 광주·전남 AWS 관리 — 앱처럼 쓰기 위한 서비스 워커
// 화면 뼈대와 장비 목록(CSV)만 저장해 두고, 사진·파노라마·지도 타일·길찾기 API는 가로채지 않고 항상 네트워크로 보냅니다.
const CACHE = 'aws-dash-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const SKIP_PATHS = ['/panoramas/', '/photos/', '/observation_support_site/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (url.origin !== location.origin) return;                       // 외부 요청은 그대로 네트워크
  if (SKIP_PATHS.some((p) => url.pathname.includes(p))) return;     // 큰 이미지·출장지 앱은 가로채지 않음

  // 네트워크 우선(CSV·화면 수정이 바로 반영), 실패하면 저장본
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
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }))
  );
});
