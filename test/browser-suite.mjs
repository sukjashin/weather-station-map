/* 브라우저 자동 점검 — 화면을 실제로 띄워 눌러 보고 결과를 확인합니다.
 *
 *   npm install --no-save playwright   (처음 한 번)
 *   node test/browser-suite.mjs
 *
 * 정적 서버와 시험용 데이터는 이 스크립트가 알아서 만들고 끝나면 지웁니다.
 * 실패가 하나라도 있으면 종료 코드 1로 끝납니다.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── playwright 찾기 (프로젝트 → 전역 순) ── */
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const req = createRequire(import.meta.url);
    const g = req.resolve('playwright', { paths: ['/opt/node22/lib/node_modules', '/usr/lib/node_modules'] });
    ({ chromium } = (await import(pathToFileURL(g).href)).default ?? await import(pathToFileURL(g).href));
  } catch {
    console.error('playwright를 찾지 못했습니다. 먼저 실행하세요:\n  npm install --no-save playwright');
    process.exit(2);
  }
}

/* ── 상태 계산 확인용 시험 데이터 ──
   오늘 날짜를 기준으로 판정되므로 날짜는 실행 시점에 맞춰 만듭니다. */
const today = new Date(); today.setHours(0, 0, 0, 0);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthsBefore = (n, plusDays = 0) => {
  const d = new Date(today); d.setDate(d.getDate() + plusDays); d.setMonth(d.getMonth() - n); return iso(d);
};
const FIXTURE_CSV = `station_id,name,lat,lon,address,last_check,cycle_months,panorama,note
901,지남테스트,35.10,126.90,광주 테스트,${monthsBefore(7)},6,,예정일 한 달 지남
902,곧도래테스트,35.11,126.91,광주 테스트,${monthsBefore(6, 16)},6,,예정일 16일 남음
903,정상테스트,35.12,126.92,광주 테스트,${iso(today)},6,,예정일 6개월 뒤
904,빈칸테스트,35.13,126.93,광주 테스트,,,,점검정보 없음
905,형식오류테스트,35.14,126.94,광주 테스트,2026-13-45,6,,잘못된 날짜
906,좌표오류테스트,없음,없음,광주 테스트,${iso(today)},6,,좌표 파싱 불가
907,"인용부호,쉼표테스트",35.15,126.95,"광주 테스트, 쉼표 포함 주소",${iso(today)},6,,
908,<b>이스케이프</b>,35.16,126.96,광주 테스트,${iso(today)},6,,
909,외부주소사진,35.17,126.97,광주 테스트,${iso(today)},6,https://example.test/pano/909.jpg,사진을 다른 서버에 둔 경우
910,폴더사진,35.18,126.98,광주 테스트,${iso(today)},6,910.jpg,저장소 폴더에 둔 경우
`;

/* 해양장비 시험 데이터 — 선박·육상·업체 세 가지 접근 방식을 모두 담습니다. */
const FIXTURE_MARINE = `station_id,name,kind,lat,lon,sea_area,access,port,port_address,port_lat,port_lon,boat_min,wave_limit,vendor,vendor_tel,last_check,cycle_months,photo,note
22101,칠발도,부이,34.79300,125.77700,서해남부 먼바다,선박,목포항,전라남도 목포시 해안로 182,34.78500,126.37800,180,1.5,,,${iso(today)},12,,계류 점검 포함
22103,신안,부이,34.68000,125.90000,서해남부 앞바다,선박,목포항,전라남도 목포시 해안로 182,34.78500,126.37800,120,2.0,,,${iso(today)},12,,
22102,거문도,부이,34.00100,127.50000,남해서부 먼바다,선박,여수항,전라남도 여수시 종화동 458,34.73800,127.75200,240,1.5,,,${iso(today)},12,,
22201,가거도등표,등표,34.05000,125.10000,서해남부 먼바다,업체,,,,,,1.0,해양장비유지보수(주),061-000-0000,${iso(today)},6,,업체 정기점검
22301,목포항파고,파고,34.77000,126.36000,목포항,육상,,,,,,,,,${iso(today)},6,,방파제 끝단 도보 접근
22401,여수연안방재,연안,34.74500,127.74000,여수 연안,육상,,,,,,,,,${iso(today)},6,,
`;

const FIX = await fsp.mkdtemp(path.join(os.tmpdir(), 'aws-fixture-'));
await fsp.mkdir(path.join(FIX, 'data'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'index.html'), path.join(FIX, 'index.html'));
await fsp.writeFile(path.join(FIX, 'data', 'stations.csv'), FIXTURE_CSV);
await fsp.writeFile(path.join(FIX, 'data', 'marine.csv'), FIXTURE_MARINE);

/* ── 정적 서버 (저장소 루트 + /__fixture) ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  // 픽스처 페이지도 저장소의 vendor/ 파일을 그대로 씁니다.
  const inFixture = url.startsWith('/__fixture');
  if (inFixture) url = url.slice('/__fixture'.length) || '/';
  const base = inFixture && !url.startsWith('/vendor/') ? FIX : ROOT;
  const file = path.join(base, url === '/' ? 'index.html' : url);
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ── 판정 도우미 ── */
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/* ── 경로탐색 서버 응답 흉내 (직선거리 × 1.35, islandIdx 지점은 도로 불가) ── */
function fakeTable(coords, islandIdx = 3) {
  const pts = coords.split(';').map(c => c.split(',').map(Number));
  const R = 6371, rad = Math.PI / 180;
  const d = (a, b) => {
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const n = pts.length, distances = [], durations = [];
  for (let i = 0; i < n; i++) {
    distances.push([]); durations.push([]);
    for (let j = 0; j < n; j++) {
      const island = islandIdx != null && (i === islandIdx || j === islandIdx) && i !== j;
      const km = d(pts[i], pts[j]) * 1.35;
      distances[i].push(island ? null : km * 1000);
      durations[i].push(island ? null : (km / 65) * 3600);
    }
  }
  return { code: 'Ok', distances, durations };
}
const stubOsrm = (p, islandIdx = 3) => p.route('**/router.project-osrm.org/**', async r => {
  const coords = new URL(r.request().url()).pathname.split('/driving/')[1];
  await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeTable(coords, islandIdx)) });
});

const browser = await chromium.launch();
const pageErrors = [];
async function newPage(w = 390, h = 900) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  p.on('pageerror', e => pageErrors.push(String(e)));
  return p;
}
const ready = p => p.waitForFunction(() => typeof state !== 'undefined' && state.stations.length > 0, { timeout: 15000 });

try {
  /* ───────── 1. 데이터 로드 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    const d = await p.evaluate(() => ({
      n: state.stations.length,
      invalid: state.stations.filter(s => !s.valid).map(s => s.id),
      dupes: state.stations.length - new Set(state.stations.map(s => s.id)).size,
      sorted: state.stations.every((s, i, a) => i === 0 || +a[i - 1].id <= +s.id),
      comma: state.stations.find(s => s.id === '776')?.address,
      base: document.getElementById('dataBase').textContent
    }));
    ok('1-1 지점을 모두 읽음', d.n > 0, `${d.n}개소`);
    eq('1-2 좌표 오류 없음', d.invalid, []);
    eq('1-3 지점번호 중복 없음', d.dupes, 0);
    ok('1-4 지점번호 오름차순', d.sorted);
    eq('1-5 쉼표 포함 주소 파싱(776 현산)', d.comma, '전라남도 해남군 현산면 일평리 529-7, 529-6');
    ok('1-6 CSV 기준 표기', d.base.includes('CSV 기준'), d.base);
    await p.close();
  }

  /* ───────── 2. 검색 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    // 결과 없음 안내 줄(li.empty)은 빼고 실제 항목만 센다
    const count = async q => { await p.fill('#q', q); await p.waitForTimeout(250); return p.$$eval('#list li.item', n => n.length); };
    const mode = async i => { await p.click(`#modes button:nth-child(${i})`); await p.waitForTimeout(150); };

    await count('진도');
    ok('2-1 검색 입력 시 목록 자동 펼침', await p.$eval('#listBox', n => !n.hidden));
    eq('2-2 전체 검색 "진도"', await count('진도'), 7);
    eq('2-3 전체 검색은 번호도 매칭 "156"', await count('156'), 1);
    await mode(2);
    eq('2-4 주소 검색 "신안군"', await count('신안군'), 13);
    eq('2-5 주소 검색 "흑산도"(주소에 흑산도관측소 포함)', await count('흑산도'), 1);
    eq('2-6 주소 검색은 지점명 무시 "솔라시도"', await count('솔라시도'), 0);
    await mode(3);
    eq('2-7 번호 검색 "165"', await count('165'), 1);
    eq('2-8 번호 검색은 지점명 무시 "목포"', await count('목포'), 0);
    await mode(1);
    eq('2-9 없는 검색어', await count('없는지점명xyz'), 0);
    ok('2-10 빈 결과 안내 문구', (await p.$eval('#list', n => n.innerText)).includes('조건에 맞는 장비가 없습니다'));
    await p.close();
  }

  /* ───────── 3. 상태 자동 계산 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/__fixture/index.html`); await ready(p);
    const d = await p.evaluate(() => Object.fromEntries(
      state.stations.map(s => [s.name, { st: s.status.key, days: s.days }])));
    eq('3-1 예정일 지남 → 점검필요', d['지남테스트'].st, 'due');
    eq('3-2 30일 이내 → 곧 도래', d['곧도래테스트'].st, 'soon');
    eq('3-3 남은 일수 계산', d['곧도래테스트'].days, 16);
    eq('3-4 그 외 → 정상', d['정상테스트'].st, 'ok');
    eq('3-5 빈칸 → 정보 확인 필요', d['빈칸테스트'].st, 'unknown');
    eq('3-6 잘못된 날짜 → 정보 확인 필요', d['형식오류테스트'].st, 'unknown');
    eq('3-7 좌표 파싱 불가 감지', await p.evaluate(() => state.stations.filter(s => !s.valid).map(s => s.name)), ['좌표오류테스트']);
    const esc = await p.evaluate(() => {
      const n = [...document.querySelectorAll('#list .item-name')].find(x => x.textContent.includes('이스케이프'));
      return { text: n.textContent, hasBold: !!n.querySelector('b') };
    });
    ok('3-8 HTML 이스케이프 처리', esc.text === '<b>이스케이프</b>' && !esc.hasBold, JSON.stringify(esc));

    await p.click('#listToggle'); await p.waitForTimeout(200);
    const filt = async f => { await p.click(`#chips button[data-f="${f}"]`); await p.waitForTimeout(200); return p.$$eval('#list li.item', n => n.length); };
    eq('3-9 필터 점검필요', await filt('due'), 1);
    eq('3-10 필터 곧 도래', await filt('soon'), 1);
    eq('3-11 필터 정상', await filt('ok'), 6);
    eq('3-12 필터 전체', await filt('all'), 10);
    await p.close();
  }

  /* ───────── 4. 목록·상세·파노라마 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    ok('4-1 목록 기본 접힘', await p.$eval('#listBox', n => n.hidden));
    await p.click('#listToggle'); await p.waitForTimeout(200);
    ok('4-2 제목 클릭 시 펼침', !(await p.$eval('#listBox', n => n.hidden)));

    await p.click('#list li[data-id="156"] button.item-main'); await p.waitForTimeout(500);
    ok('4-3 상세 카드 열림', await p.$eval('#sheet', n => n.classList.contains('show')));
    const info = await p.$eval('#sheetBody', n => n.innerText);
    ok('4-4 상세에 지점번호·좌표', info.includes('156') && info.includes('35.1729, 126.8916'));
    ok('4-5 길안내는 현위치 출발 표기', info.includes('길안내 (현위치 출발)'));
    const navHref = decodeURIComponent(await p.$eval('.sheet-btns a', n => n.getAttribute('href')));
    ok('4-5b 상세 길안내는 도착지 좌표만 지정',
      navHref === 'https://map.naver.com/p/directions/-/126.89156,35.17294,광주,,/-/car', navHref);

    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    ok('4-6 ESC로 닫힘', !(await p.$eval('#sheet', n => n.classList.contains('show'))));

    await p.click('#list li[data-id="156"] button.item-main'); await p.waitForTimeout(400);
    // 시트가 화면 대부분을 덮으므로 위쪽 여백(어두운 배경)을 누른다
    await p.mouse.click(195, 30); await p.waitForTimeout(400);
    ok('4-7 배경 클릭으로 닫힘', !(await p.$eval('#sheet', n => n.classList.contains('show'))));

    await p.click('#list li[data-id="156"] button.item-main'); await p.waitForTimeout(400);
    await p.click('#sheetBody [data-act="pano"]'); await p.waitForTimeout(1200);
    const pano = await p.evaluate(() => {
      const el = document.getElementById('pano');
      return { exists: !!el, bg: el ? getComputedStyle(el).backgroundImage : '', pick: document.getElementById('panoPick').innerText };
    });
    ok('4-8 파노라마 렌더링', pano.exists && pano.bg.includes('156.svg'), pano.bg.slice(0, 70));
    eq('4-9 선택된 장비 표기', pano.pick, '선택된 장비: 광주');
    const before = await p.$eval('#pano', n => getComputedStyle(n).backgroundPositionX);
    await p.mouse.move(200, 400); await p.mouse.down(); await p.mouse.move(80, 400, { steps: 8 }); await p.mouse.up();
    await p.waitForTimeout(300);
    const after = await p.$eval('#pano', n => getComputedStyle(n).backgroundPositionX);
    ok('4-10 파노라마 드래그로 회전', before !== after, `${before} → ${after}`);

    await p.click('#list li[data-id="165"] button.item-main'); await p.waitForTimeout(400);
    await p.click('#sheetBody [data-act="pano"]'); await p.waitForTimeout(600);
    ok('4-11 파노라마 미등록 안내', (await p.$eval('#panoWrap', n => n.innerText)).includes('촬영 예정입니다'));
    await p.close();
  }

  /* ───────── 5. 담기 제한 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    await p.click('#listToggle'); await p.waitForTimeout(200);
    let alertMsg = null;
    p.on('dialog', async d => { alertMsg = d.message(); await d.dismiss(); });
    for (let i = 0; i < 9; i++) { await p.locator('#list li button.pick').nth(i).click(); await p.waitForTimeout(120); }
    eq('5-1 최대 8곳까지만 담김', await p.evaluate(() => state.picked.length), 8);
    ok('5-2 초과 시 안내', (alertMsg || '').includes('최대 8곳'), String(alertMsg));
    await p.locator('.tag button').first().click(); await p.waitForTimeout(200);
    eq('5-3 태그 ✕로 빼기', await p.evaluate(() => state.picked.length), 7);
    eq('5-4 버튼 문구', await p.$eval('#calcBtn', n => n.textContent.trim()), '7곳 방문 순서 계산하기');
    await p.close();
  }

  /* ───────── 5.5 지도 핀 ─────────
     지도 라이브러리를 저장소 안에 두었으므로 실제 Leaflet으로 확인합니다.
     (배경 타일만 외부에서 받아오며, 없어도 핀은 그려집니다) */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    await p.waitForTimeout(400);
    const pins = () => p.evaluate(() => [...document.querySelectorAll('.leaflet-marker-icon .pin')]
      .map(n => ({ cls: [...n.classList].filter(c => c !== 'pin').join(' '), text: n.textContent.trim() })));
    const tip = id => p.evaluate(i => state.markers[i]?.getTooltip()?.getContent() ?? null, id);

    ok('5.5-0 Leaflet이 저장소에서 로드됨', await p.evaluate(() => typeof L !== 'undefined' && !!state.map));
    eq('5.5-1 처음에는 핀이 하나도 없음', (await pins()).length, 0);

    await p.click('#listToggle'); await p.waitForTimeout(200);
    await p.click('#list li[data-id="165"] button.item-main'); await p.waitForTimeout(500);
    let cur = await pins();
    eq('5.5-2 장비를 선택하면 핀 1개', cur.length, 1);
    eq('5.5-3 선택 핀 모양', cur[0].cls, 'pin-sel');
    eq('5.5-4 선택 핀 말풍선', await tip('165'), '목포');
    ok('5.5-5 핀에 글씨 없음', cur.every(x => x.text === ''), JSON.stringify(cur));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    eq('5.5-6 상세를 닫아도 위치 핀은 남음', (await pins()).length, 1);

    await p.locator('#list li[data-id="168"] button.pick').click(); await p.waitForTimeout(300);
    cur = await pins();
    eq('5.5-7 출장지 담으면 사무실+출장지+선택 = 3개', cur.length, 3);
    eq('5.5-8 사무실 핀', cur.filter(x => x.cls === 'pin-office').length, 1);
    eq('5.5-9 출장지 핀', cur.filter(x => x.cls === 'pin-pick').length, 1);
    ok('5.5-10 전부 글씨 없음', cur.every(x => x.text === ''), JSON.stringify(cur));

    // 선택한 장비를 그대로 담으면 핀이 겹쳐 늘지 않아야 한다
    await p.locator('#list li[data-id="165"] button.pick').click(); await p.waitForTimeout(300);
    eq('5.5-11 선택 장비를 담아도 핀 중복 없음', (await pins()).length, 3);
    eq('5.5-12 담긴 선택 핀 말풍선', await tip('165'), '목포 · 출장지');

    await p.locator('#list li[data-id="168"] button.pick').click(); await p.waitForTimeout(250);
    await p.locator('#list li[data-id="165"] button.pick').click(); await p.waitForTimeout(250);
    cur = await pins();
    eq('5.5-13 출장지를 모두 빼면 선택 핀만 남음', cur.length, 1);
    eq('5.5-14 사무실 핀도 사라짐', cur.filter(x => x.cls === 'pin-office').length, 0);
    await p.close();
  }

  /* ───────── 6. 경로 — 도로 계산 ───────── */
  {
    const p = await newPage();
    await stubOsrm(p);
    await p.goto(`${BASE}/index.html`); await ready(p);
    await p.click('#listToggle'); await p.waitForTimeout(200);
    for (const id of ['165', '168', '169']) { await p.locator(`#list li[data-id="${id}"] button.pick`).click(); await p.waitForTimeout(120); }
    await p.click('#calcBtn');
    await p.waitForSelector('.route-total', { timeout: 20000 });
    await p.waitForTimeout(300);

    const txt = await p.$eval('#routeResult', n => n.innerText);
    ok('6-1 도로 기준 표기', txt.includes('도로 기준'));
    ok('6-2 총 이동거리·총 소요시간 함께 표시', /총 이동거리[\s\S]*총 소요시간/.test(txt), txt.split('\n').slice(0, 5).join(' / '));
    ok('6-3 구간별 도로 거리·시간 표시', /도로 약 [\d.,]+km · 약 .+/.test(txt));
    ok('6-4 섬 구간은 직선 + 예상시간 + 사유 표시',
      /직선 약 [\d.,]+km · 예상 .+/.test(txt) && txt.includes('도로 경로를 찾지 못했습니다'));
    ok('6-5 실패 배너 없음', !(await p.$('.route-warn')));

    const officeName = await p.evaluate(() => CONFIG.office.name);
    const legs = await p.$$eval('.leg-path', ns => ns.map(n => n.innerText.replace(/\s+/g, ' ').trim()));
    eq('6-6 구간 수 = 담은 수 + 1', legs.length, 4);
    const chain = legs.map(l => l.split('→').map(s => s.trim()));
    ok('6-7 첫 구간 출발지가 사무실', chain[0][0] === officeName, legs[0]);
    ok('6-8 마지막 구간 도착지가 사무실', chain.at(-1)[1] === officeName, legs.at(-1));
    ok('6-9 구간이 끊김 없이 이어짐', chain.every((c, i) => i === 0 || chain[i - 1][1] === c[0]), JSON.stringify(chain));

    const hrefs = await p.$$eval('.leg-nav', ns => ns.map(n => decodeURIComponent(n.getAttribute('href'))));
    const coordOf = await p.evaluate(() => {
      const m = {}; state.stations.forEach(s => m[s.name] = [s.lat, s.lon]);
      m[CONFIG.office.name] = [CONFIG.office.lat, CONFIG.office.lon]; return m;
    });
    ok('6-10 길안내 링크의 출발·도착 좌표 일치', hrefs.every((h, i) => {
      const [from, to] = chain[i];
      return h.includes(`/directions/${coordOf[from][1]},${coordOf[from][0]},${from},,/`)
          && h.includes(`/${coordOf[to][1]},${coordOf[to][0]},${to},,/`);
    }), hrefs[1]);
    ok('6-11 네이버지도 자동차 길찾기 형식',
      hrefs.every(h => h.startsWith('https://map.naver.com/p/directions/') && h.endsWith('/-/car')), hrefs[0]);

    // 화면에 표시된 순서가 정말 최단인지 완전탐색으로 대조
    const optimal = await p.evaluate(() => {
      const pts = [CONFIG.office, ...state.picked.map(id => state.stations.find(s => s.id === id))];
      const R = 6371, rad = Math.PI / 180;
      const d = (a, b) => {
        const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const cost = (i, j) => (i === 3 || j === 3) ? d(pts[i], pts[j]) : d(pts[i], pts[j]) * 1.35;
      let best = null;
      const perm = (arr, cur) => {
        if (!arr.length) {
          let t = 0, prev = 0;
          for (const k of [...cur, 0]) { t += cost(prev, k); prev = k; }
          if (!best || t < best.t) best = { t, order: cur.map(i => pts[i].name) };
          return;
        }
        for (let i = 0; i < arr.length; i++) perm(arr.slice(0, i).concat(arr.slice(i + 1)), cur.concat(arr[i]));
      };
      perm(pts.map((_, i) => i).slice(1), []);
      return best;
    });
    const shown = await p.$$eval('.step-link .step-name', ns => ns.map(n => n.textContent.trim()));
    eq('6-12 방문 순서가 최단 순서와 일치', shown, optimal.order);
    const totalShown = +(await p.$eval('.route-total b', n => n.textContent)).replace(/[^\d.]/g, '');
    ok('6-13 총거리가 최단 비용과 일치', Math.abs(totalShown - optimal.t) < 1.5, `화면 ${totalShown} vs 계산 ${optimal.t.toFixed(1)}`);

    await p.locator('.step-link').nth(1).click(); await p.waitForTimeout(500);
    ok('6-14 방문지 클릭 → 상세 열림', await p.$eval('#sheet', n => n.classList.contains('show')));
    eq('6-15 열린 상세가 그 지점', await p.$eval('#sheetName', n => n.textContent.trim()), shown[1]);
    await p.close();
  }

  /* ───────── 6.5 모든 지점의 길안내 검색어 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);
    const bad = await p.evaluate(() => state.stations
      .map(s => ({ id: s.id, name: s.name, q: navQuery(s) }))
      .filter(x => !x.q || x.q === x.name || x.q.length < 6));
    eq('6.5-1 주소로 검색어를 못 만드는 지점 없음', bad, []);
    eq('6.5-2 사무실 검색어', await p.evaluate(() => navQuery(CONFIG.office)), '광주광역시 북구 서암대로 71');
    // navProvider를 kakao로 바꿔도 링크가 만들어지는지
    const kakao = await p.evaluate(() => {
      CONFIG.navProvider = 'kakao';
      const s = state.stations.find(x => x.id === '165');
      return { leg: navLink(CONFIG.office, s), to: navToLink(s) };
    });
    ok('6.5-3 kakao로 바꾸면 주소 검색 링크', kakao.leg.startsWith('https://map.kakao.com/?sName='), kakao.leg);
    ok('6.5-4 kakao 상세 링크', kakao.to.startsWith('https://map.kakao.com/link/to/'), kakao.to);
    await p.close();
  }

  /* ───────── 7. 경로 — 실패 시 직선 폴백 ───────── */
  {
    for (const [label, handler, expect] of [
      ['500 응답', r => r.fulfill({ status: 500, body: 'err' }), '경로 서버 응답 500'],
      ['잘못된 형식', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"code":"NoRoute"}' }), 'NoRoute'],
      ['연결 실패', r => r.abort(), 'Failed to fetch']
    ]) {
      const p = await newPage();
      await p.route('**/router.project-osrm.org/**', handler);
      await p.goto(`${BASE}/index.html`); await ready(p);
      await p.click('#listToggle'); await p.waitForTimeout(200);
      for (const id of ['165', '168']) { await p.locator(`#list li[data-id="${id}"] button.pick`).click(); await p.waitForTimeout(120); }
      await p.click('#calcBtn');
      await p.waitForSelector('.route-total', { timeout: 20000 });
      const warn = await p.$eval('.route-warn', n => n.innerText).catch(() => '');
      const txt = await p.$eval('#routeResult', n => n.innerText);
      ok(`7-${label} 직선으로 폴백 + 사유 표시`, warn.includes('직선거리') && warn.includes(expect), warn.replace(/\n/g, ' '));
      ok(`7-${label} 섬 경고 오표시 없음`, !txt.includes('도로 경로를 찾지 못했습니다'));
      ok(`7-${label} 계산 버튼 복구`, !(await p.$eval('#calcBtn', n => n.disabled)));
      await p.close();
    }
  }

  /* ───────── 8. provider:'straight' ───────── */
  {
    const p = await newPage();
    let called = false;
    await p.route('**/router.project-osrm.org/**', r => { called = true; r.abort(); });
    await p.goto(`${BASE}/index.html`);
    await p.evaluate(() => { CONFIG.routing.provider = 'straight'; });
    await ready(p);
    await p.click('#listToggle'); await p.waitForTimeout(200);
    for (const id of ['165', '168']) { await p.locator(`#list li[data-id="${id}"] button.pick`).click(); await p.waitForTimeout(120); }
    await p.click('#calcBtn'); await p.waitForSelector('.route-total', { timeout: 10000 });
    ok('8-1 외부 호출 안 함', !called);
    ok('8-2 직선·추정 기준 표기', (await p.$eval('.route-total', n => n.innerText)).includes('직선거리와 평균 시속'));
    ok('8-3 도로 없이도 소요시간 표시', (await p.$eval('.route-total', n => n.innerText)).includes('총 소요시간'));
    ok('8-4 실패 배너 없음', !(await p.$('.route-warn')));
    await p.close();
  }

  /* ───────── 9. 내장 사본 (파일 직접 열기) ───────── */
  {
    const p = await newPage();
    await p.goto(pathToFileURL(path.join(ROOT, 'index.html')).href); await ready(p);
    const d = await p.evaluate(() => ({ n: state.stations.length, base: document.getElementById('dataBase').textContent }));
    ok('9-1 내장 사본으로도 전 지점 표시', d.n > 0, `${d.n}개소`);
    ok('9-2 내장 사본 표기', d.base.includes('내장 사본'), d.base);
    ok('9-3 안내 배너 노출', (await p.$eval('#banner', n => n.innerText)).includes('내장 사본'));
    await p.close();
  }

  /* ───────── 10. 레이아웃 ───────── */
  {
    for (const [w, h, tag] of [[360, 780, '360px'], [390, 900, '390px'], [1280, 900, '1280px']]) {
      const p = await newPage(w, h);
      await stubOsrm(p, null);
      await p.goto(`${BASE}/index.html`); await ready(p);
      await p.click('#listToggle'); await p.waitForTimeout(200);
      for (const id of ['165', '168', '169']) { await p.locator(`#list li[data-id="${id}"] button.pick`).click(); await p.waitForTimeout(120); }
      await p.click('#calcBtn'); await p.waitForSelector('.route-total'); await p.waitForTimeout(300);
      ok(`10-${tag} 가로 스크롤 없음`,
        !(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
      const hgt = await p.$eval('.route-total b', n => n.getBoundingClientRect().height);
      ok(`10-${tag} 총거리 숫자 한 줄`, hgt < 40, `높이 ${hgt.toFixed(0)}px`);
      await p.close();
    }
  }
  /* ───────── 11. 해양장비 탭 ───────── */
  {
    const p = await newPage();
    await stubOsrm(p, null);
    await p.goto(`${BASE}/__fixture/index.html`); await ready(p);

    eq('11-1 탭 두 개', await p.$$eval('#tabs .tab', ns => ns.map(n => n.textContent.trim())),
      ['지상 AWS', '해양장비']);
    await p.click('#tabs .tab[data-tab="marine"]'); await p.waitForTimeout(400);
    eq('11-2 해양장비를 읽음', await p.evaluate(() => state.marine.length), 6);
    eq('11-3 탭 전환 시 담은 목록 초기화', await p.evaluate(() => state.picked.length), 0);
    ok('11-4 출항 계획 섹션으로 바뀜', !!(await p.$('#seaSec')) && (await p.$eval('#routeSec h2', n => n.textContent)) === '출항 계획');
    eq('11-5 종류 필터가 실제 있는 종류만',
      await p.$$eval('#kinds .chip', ns => ns.map(n => n.textContent.trim())),
      ['전체 종류', '해양기상부이', '등표관측장비', '파고부이·파랑계', '연안·항만']);

    await p.click('#listToggle'); await p.waitForTimeout(250);
    eq('11-6 목록 건수', await p.$eval('#listCount', n => n.textContent), '6곳');
    const kind = async k => { await p.click(`#kinds .chip[data-k="${k}"]`); await p.waitForTimeout(200); return p.$$eval('#list li.item', n => n.length); };
    eq('11-7 종류 필터 부이', await kind('buoy'), 3);
    eq('11-8 종류 필터 등표', await kind('light'), 1);
    eq('11-9 종류 필터 전체', await kind('all'), 6);

    const find = async q => { await p.fill('#q', q); await p.waitForTimeout(250); return p.$$eval('#list li.item', n => n.length); };
    await p.click('#modes .chip[data-m="addr"]'); await p.waitForTimeout(150);
    eq('11-10 해역·항구 검색 "목포항"', await find('목포항'), 3);   // 목포항 출항 2 + 해역이 목포항 1
    eq('11-11 해역 검색 "남해서부"', await find('남해서부'), 1);
    await p.click('#modes .chip[data-m="all"]'); await p.waitForTimeout(150);
    await find('');

    // 담기 → 출항 계획
    for (const id of ['22101', '22103', '22201', '22301']) {
      await p.locator(`#list li[data-id="${id}"] button.pick`).click(); await p.waitForTimeout(150);
    }
    eq('11-12 출항 조건은 선박 장비만 반영', await p.$eval('#waveWorst', n => n.textContent), '1.5m 이하');
    eq('11-13 계산 버튼 문구', await p.$eval('#calcBtn', n => n.textContent.trim()), '4곳 출항 계획 짜기');

    await p.click('#calcBtn'); await p.waitForSelector('.route-total', { timeout: 20000 }); await p.waitForTimeout(300);
    const cards = await p.$$eval('.port-card .port-head b', ns => ns.map(n => n.textContent.trim()));
    eq('11-14 같은 항구는 한 묶음, 육상은 따로', cards, ['목포항', '목포항파고']);
    const txt = await p.$eval('#routeResult', n => n.innerText);
    ok('11-15 업체 점검 장비는 일정에서 제외', txt.includes('업체 점검 장비 1곳') && txt.includes('가거도등표'), '');
    ok('11-16 항구까지 도로 구간 표시', /광주지방기상청 → 목포항\s+도로 약/.test(txt.replace(/\n/g, ' ')), '');
    ok('11-17 왕복 항해 시간 표시', txt.includes('왕복 항해 약 10시간'), '');
    ok('11-18 육상 접근은 항해 표기 없음', txt.includes('차로 가서 걸어서 접근'), '');
    ok('11-19 총계에 점검시간 제외 안내', txt.includes('점검 작업 시간과 대기 시간은 빠져 있습니다'), '');

    const navs = await p.$$eval('.port-card .leg-nav', ns => ns.map(n => decodeURIComponent(n.getAttribute('href'))));
    ok('11-20 항구 길안내는 항구 좌표로', navs[0].includes('126.378,34.785,목포항,,'), navs[0]);

    // 지도 핀
    const pins = await p.evaluate(() => [...document.querySelectorAll('.leaflet-marker-icon .pin')]
      .map(n => [...n.classList].filter(c => c !== 'pin').join(' ')));
    eq('11-21 출항 항구 핀', pins.filter(c => c === 'pin-port').length, 1);
    ok('11-22 사무실 핀', pins.includes('pin-office'), pins.join(' '));

    // 상세
    await p.locator('.port-list .step-link').first().click(); await p.waitForTimeout(500);
    const sheet = await p.$eval('#sheetBody', n => n.innerText);
    ok('11-23 상세에 접근 방식·항구·파고', sheet.includes('선박 출항') && sheet.includes('목포항 · 편도 약 3시간')
      && sheet.includes('1.5m 이하'), sheet.replace(/\n/g, ' ').slice(0, 160));
    ok('11-24 항구까지 길안내 버튼', (await p.$eval('.sheet-btns a', n => n.textContent)).includes('목포항까지 길안내'));
    ok('11-25 해양에는 파노라마 버튼 없음', !(await p.$('#sheetBody [data-act="pano"]')));
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);

    // 업체 점검 장비 상세
    await p.evaluate(() => setListOpen(true)); await p.waitForTimeout(200);
    await p.locator('#list li[data-id="22201"] button.item-main').click(); await p.waitForTimeout(400);
    const vend = await p.$eval('#sheetBody', n => n.innerText);
    ok('11-26 업체 정보 표시', vend.includes('해양장비유지보수(주)') && vend.includes('061-000-0000'), '');
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);

    // 지상으로 되돌아가기
    await p.click('#tabs .tab[data-tab="land"]'); await p.waitForTimeout(400);
    ok('11-27 지상 탭 복귀', (await p.$eval('#routeSec h2', n => n.textContent)) === '하루 출장 경로');
    ok('11-28 지상에는 종류 필터 없음', !(await p.$('#kinds')));
    await p.close();
  }

  /* ───────── 12. 해양 자료가 없을 때 ───────── */
  {
    const p = await newPage();
    await p.goto(`${BASE}/index.html`); await ready(p);   // 저장소의 marine.csv는 머리글만 있습니다
    await p.click('#tabs .tab[data-tab="marine"]'); await p.waitForTimeout(400);
    const t = await p.$eval('#app', n => n.innerText);
    ok('12-1 빈 자료 안내', t.includes('등록된 해양장비가 없습니다'), t.split('\n')[1] || '');
    ok('12-2 채워야 할 칸 안내', t.includes('boat_min') && t.includes('wave_limit') && t.includes('access'), '');
    ok('12-3 자바스크립트 오류 없이 지상 복귀', await (async () => {
      await p.click('#tabs .tab[data-tab="land"]'); await p.waitForTimeout(400);
      return (await p.$$eval('#list li.item', n => n.length)) >= 0;
    })());
    await p.close();
  }

  /* ───────── 13. 외부 의존성 ───────── */
  {
    const p = await newPage();
    const external = [];
    p.on('request', r => {
      const u = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(u.origin);
    });
    await p.goto(`${BASE}/index.html`); await ready(p);
    await p.click('#listToggle'); await p.waitForTimeout(300);
    await p.locator('#list li button.pick').first().click(); await p.waitForTimeout(200);
    await p.click('#calcBtn'); await p.waitForSelector('.route-total', { timeout: 20000 });
    const hosts = [...new Set(external)].sort();
    eq('13-1 외부 요청은 지도 타일과 경로 서버뿐', hosts,
      ['https://router.project-osrm.org', 'https://tile.openstreetmap.org']);
    ok('13-2 지도 라이브러리는 저장소 안에서 로드',
      (await p.evaluate(() => typeof L !== 'undefined')), '');
    ok('13-3 CDN 요청 없음', !hosts.some(h => /unpkg|cdn|jsdelivr/.test(h)), hosts.join(' '));

    // 외부를 전부 막아도 목록·경로가 동작하는지
    const p2 = await newPage();
    await p2.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
    const errs2 = []; p2.on('pageerror', e => errs2.push(String(e)));
    await p2.goto(`${BASE}/index.html`); await ready(p2);
    ok('13-4 외부 차단해도 지도 라이브러리 동작', await p2.evaluate(() => typeof L !== 'undefined'));
    await p2.click('#listToggle'); await p2.waitForTimeout(300);
    ok('13-5 외부 차단해도 목록 표시', (await p2.$$eval('#list li.item', n => n.length)) > 0);
    await p2.locator('#list li button.pick').first().click(); await p2.waitForTimeout(200);
    await p2.click('#calcBtn'); await p2.waitForSelector('.route-total', { timeout: 20000 });
    ok('13-6 외부 차단해도 경로 계산(직선 폴백)',
      (await p2.$eval('#routeResult', n => n.innerText)).includes('직선거리'), '');
    eq('13-7 자바스크립트 오류 없음', errs2, []);
    await p2.close();
    await p.close();
  }

  /* ───────── 14. 사진을 다른 서버에 둔 경우 ───────── */
  {
    const p = await newPage();
    // 바깥 사진 요청은 실제로 나가지 않게 가로채 1x1 그림으로 응답합니다.
    const asked = [];
    await p.route('https://example.test/**', async r => {
      asked.push(r.request().url());
      await r.fulfill({ status: 200, contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') });
    });
    await p.goto(`${BASE}/__fixture/index.html`); await ready(p);
    await p.click('#listToggle'); await p.waitForTimeout(250);

    await p.click('#list li[data-id="909"] button.item-main'); await p.waitForTimeout(300);
    await p.click('#sheetBody [data-act="pano"]'); await p.waitForTimeout(900);
    const bg1 = await p.$eval('#pano', n => getComputedStyle(n).backgroundImage);
    ok('14-1 http 주소는 그대로 사용', bg1.includes('https://example.test/pano/909.jpg'), bg1);
    ok('14-2 실제로 그 주소를 요청', asked.some(u => u.endsWith('/pano/909.jpg')), asked.join(' '));

    await p.click('#list li[data-id="910"] button.item-main'); await p.waitForTimeout(300);
    await p.click('#sheetBody [data-act="pano"]'); await p.waitForTimeout(900);
    const wrap = await p.$eval('#panoWrap', n => n.innerHTML + n.innerText);
    ok('14-3 파일명만 적으면 panoramas 폴더에서 찾음',
      wrap.includes('panoramas/910.jpg'), wrap.slice(0, 140));
    await p.close();
  }

} finally {
  await browser.close();
  server.close();
  await fsp.rm(FIX, { recursive: true, force: true });
}

console.log('\n──────── 요약 ────────');
const failed = results.filter(r => !r.pass);
console.log(`${results.length}건 중 ${results.length - failed.length}건 통과, ${failed.length}건 실패`);
failed.forEach(f => console.log(`  FAIL ${f.name} — ${f.detail}`));
console.log('페이지 오류:', pageErrors.length ? pageErrors : '없음');
process.exit(failed.length ? 1 : 0);
