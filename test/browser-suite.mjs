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
`;

const FIX = await fsp.mkdtemp(path.join(os.tmpdir(), 'aws-fixture-'));
await fsp.mkdir(path.join(FIX, 'data'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'index.html'), path.join(FIX, 'index.html'));
await fsp.writeFile(path.join(FIX, 'data', 'stations.csv'), FIXTURE_CSV);

/* ── 정적 서버 (저장소 루트 + /__fixture) ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  const base = url.startsWith('/__fixture') ? (url = url.slice('/__fixture'.length) || '/', FIX) : ROOT;
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
    eq('3-11 필터 정상', await filt('ok'), 4);
    eq('3-12 필터 전체', await filt('all'), 8);
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
    ok('6-2 도로 거리·소요시간 표시', /도로 약 [\d.,]+km · 약 .+/.test(txt));
    ok('6-3 섬 구간은 직선 + 사유 표시', txt.includes('직선 약') && txt.includes('도로 경로를 찾지 못했습니다'));
    ok('6-4 실패 배너 없음', !(await p.$('.route-warn')));

    const legs = await p.$$eval('.leg-path', ns => ns.map(n => n.innerText.replace(/\s+/g, ' ').trim()));
    eq('6-5 구간 수 = 담은 수 + 1', legs.length, 4);
    const chain = legs.map(l => l.split('→').map(s => s.trim()));
    ok('6-6 첫 구간 출발지가 사무실', chain[0][0] === '사무실(임시)', legs[0]);
    ok('6-7 마지막 구간 도착지가 사무실', chain.at(-1)[1] === '사무실(임시)', legs.at(-1));
    ok('6-8 구간이 끊김 없이 이어짐', chain.every((c, i) => i === 0 || chain[i - 1][1] === c[0]), JSON.stringify(chain));

    const hrefs = await p.$$eval('.leg-nav', ns => ns.map(n => decodeURIComponent(n.getAttribute('href'))));
    const coordOf = await p.evaluate(() => {
      const m = {}; state.stations.forEach(s => m[s.name] = [s.lat, s.lon]);
      m[CONFIG.office.name] = [CONFIG.office.lat, CONFIG.office.lon]; return m;
    });
    ok('6-9 길안내 링크의 출발·도착 좌표 일치', hrefs.every((h, i) => {
      const [from, to] = chain[i];
      return h.includes(`/from/${from},${coordOf[from][0]},${coordOf[from][1]}/to/${to},${coordOf[to][0]},${coordOf[to][1]}`);
    }), hrefs[1]);
    ok('6-10 카카오맵 from/to 형식', hrefs.every(h => h.startsWith('https://map.kakao.com/link/from/') && h.includes('/to/')));

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
    eq('6-11 방문 순서가 최단 순서와 일치', shown, optimal.order);
    const totalShown = +(await p.$eval('.route-total b', n => n.textContent)).replace(/[^\d.]/g, '');
    ok('6-12 총거리가 최단 비용과 일치', Math.abs(totalShown - optimal.t) < 1.5, `화면 ${totalShown} vs 계산 ${optimal.t.toFixed(1)}`);

    await p.locator('.step-link').nth(1).click(); await p.waitForTimeout(500);
    ok('6-13 방문지 클릭 → 상세 열림', await p.$eval('#sheet', n => n.classList.contains('show')));
    eq('6-14 열린 상세가 그 지점', await p.$eval('#sheetName', n => n.textContent.trim()), shown[1]);
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
    ok('8-2 직선 기준 표기', (await p.$eval('.route-total', n => n.innerText)).includes('직선 기준'));
    ok('8-3 실패 배너 없음', !(await p.$('.route-warn')));
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
