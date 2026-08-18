const loadKakaoServices = () => new Promise((resolve, reject) => {
  if (!window.kakao?.maps?.load) {
    reject(new Error('카카오 지도 서비스를 불러오지 못했습니다.'));
    return;
  }
  window.kakao.maps.load(() => {
    if (window.kakao?.maps?.services) resolve(window.kakao.maps.services);
    else reject(new Error('카카오 장소 검색 서비스를 사용할 수 없습니다.'));
  });
});

const FALLBACK_RECOMMENDATIONS = [
  {
    place_name: '순천만국가정원 동문 주차장',
    address_name: '전라남도 순천시 국가정원1호길 47',
    distance: 120,
    category_name: '주차장',
    tag: '주차장',
    score: 96,
    stars: 5,
    summary: '넓은 주차장과 편의시설이 가까운 관측 출장 추천지'
  },
  {
    place_name: '순천 오천그린광장',
    address_name: '전라남도 순천시 오천동 702',
    distance: 350,
    category_name: '광장',
    tag: '광장',
    score: 92,
    stars: 5,
    summary: '개방된 공간과 편의시설이 가까운 폭염 관측 장소'
  },
  {
    place_name: '순천역 동측 공영주차장',
    address_name: '전라남도 순천시 역전광장3길 13',
    distance: 500,
    category_name: '주차장',
    tag: '주차장',
    score: 89,
    stars: 4,
    summary: '접근성이 우수하고 편의시설이 밀집된 출장지'
  }
];

const toast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
};

const normalize = (text) => text?.replace(/\s+/g, ' ').trim() || '';

const updateHeaderSub = (text) => {
  const sub = document.querySelector('.topbar .sub');
  if (sub) sub.textContent = text;
};

let map;
let mapMarker;
let lastAddress = { x: '126.8526', y: '35.1595', address_name: '광주광역시' };
let placeMarkers = {};
let awsStationMarkers = null;
let currentPlaces = [];
let awsStations = [];

const loadAwsStations = async () => {
  try {
    const res = await fetch('../data/stations.csv', { cache: 'no-store' });
    if (!res.ok) throw new Error(`AWS CSV ${res.status}`);
    awsStations = parseCsv(await res.text()).map(station => ({
      ...station,
      latitude: station.latitude || station.lat,
      longitude: station.longitude || station.lon,
      station_name: station.station_name || station.name
    })).filter(station => Number.isFinite(Number(station.latitude)) && Number.isFinite(Number(station.longitude)));
  } catch (error) {
    awsStations = [];
    console.error('AWS 관측소 자료를 불러오지 못했습니다.', error);
  }
};

const findLocalAddress = (query) => {
  const needle = normalize(query).toLowerCase();
  const station = awsStations.find(item =>
    normalize(item.name).toLowerCase() === needle ||
    normalize(item.station_id).toLowerCase() === needle
  ) || awsStations.find(item =>
    normalize(`${item.name} ${item.address} ${item.station_id}`).toLowerCase().includes(needle)
  );
  if (station) {
    return {
      x: station.longitude,
      y: station.latitude,
      address_name: station.address || station.name,
      road_address_name: station.address || station.name
    };
  }
  if (/^광주(광역시)?$/.test(needle)) {
    return { x: '126.8526', y: '35.1595', address_name: '광주광역시' };
  }
  return null;
};

// 출장지 지도목록 전용 마커 아이콘 — 원형 과녁 무늬가 들어간 네이비 핀
const createPinIcon = ({ size = 40, fill = '#0d3b82' } = {}) => {
  const w = size;
  const h = Math.round(size * 1.3);
  return L.divIcon({
    className: 'kw-pin-icon',
    html: `
      <svg width="${w}" height="${h}" viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 1C9.507 1 1 9.507 1 20c0 14.5 19 30.5 19 30.5S39 34.5 39 20C39 9.507 30.493 1 20 1z"
          fill="${fill}" stroke="#ffffff" stroke-width="2.5"/>
        <circle cx="20" cy="20" r="11" fill="#ffffff"/>
        <circle cx="20" cy="20" r="8" fill="${fill}"/>
        <circle cx="20" cy="20" r="3.6" fill="#ffffff"/>
      </svg>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h - 2],
    popupAnchor: [0, -h + 8]
  });
};

const initMap = () => {
  map = L.map('leafletMap', {
    zoomControl: false,
    attributionControl: false
  }).setView([35.1595, 126.8526], 13);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    subdomains: ['mt0','mt1','mt2','mt3']
  }).addTo(map);

  mapMarker = L.marker([35.1595, 126.8526], { icon: createPinIcon() }).addTo(map).bindPopup('광주 기본 위치').openPopup();
  setTimeout(() => {
    if (map) map.invalidateSize();
  }, 150);
};

const updateMap = (x, y, label = '선택 위치') => {
  if (!map || !x || !y) return;
  const lat = parseFloat(y);
  const lng = parseFloat(x);
  map.setView([lat, lng], 15);
  if (mapMarker) {
    mapMarker.setLatLng([lat, lng]).setPopupContent(label).openPopup();
  } else {
    mapMarker = L.marker([lat, lng], { icon: createPinIcon() }).addTo(map).bindPopup(label).openPopup();
  }
};

const getSearchRadius = () => {
  const el = document.querySelector('input[name="radius"]:checked');
  return el ? Number(el.value) : 1000;
};

const updateDetailPanel = (place) => {
  if (!place) return;
  const name = place.place_name || place.name || '';
  const distance = place.distance ? formatDistance(place.distance) : '정보 없음';
  const category = place.category_name || place.tag || '';
  const score = place.score || '';
  const stars = place.stars ? '★'.repeat(place.stars) + '☆'.repeat(5 - place.stars) : '';
  const awsInfo = place.awsStation ? `${place.awsStation.station_name || place.awsStation.name || 'AWS 관측소'} (${formatDistance(Math.round(place.awsDistance || 0))})` : 'AWS 관측소 미등록';

  const selectedScore = document.getElementById('selectedScore');
  const selectedStars = document.getElementById('selectedStars');
  const selectedBadge = document.getElementById('selectedBadge');
  if (selectedScore) selectedScore.innerHTML = `${score}점 <span id="selectedStars" class="stars" style="font-size:15px">${stars}</span>`;
  if (selectedStars) selectedStars.textContent = stars;
  if (selectedBadge) selectedBadge.textContent = category || '추천';
  const awsInfoElem = document.getElementById('awsStationInfo');
  if (awsInfoElem) awsInfoElem.textContent = `가장 가까운 AWS 관측소: ${awsInfo}`;

  const fp = document.getElementById('facilityParking');
  const ft = document.getElementById('facilityToilet');
  const fs = document.getElementById('facilityStore');
  const fr = document.getElementById('facilityRest');
  if (fp) fp.textContent = `주차시설　${distance}`;
  if (ft) ft.textContent = `화장실　${distance}`;
  if (fs) fs.textContent = `편의점　${distance}`;
  if (fr) fr.textContent = `휴게공간　${distance}`;
};
const getStaticMapUrl = (lng, lat, w = 520, h = 200) => {
  if (!lng || !lat) return '';
  // Use Yandex static map (map tile style) for a simple street-map image without requiring an API key
  // use satellite tiles and Korean language labels where available
  return `https://static-maps.yandex.ru/1.x/?ll=${lng},${lat}&z=17&size=${Math.min(650,w)},${h}&l=sat&lang=ko_RU`;
};

const fetchWeather = async (lat, lon) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relativehumidity_2m&timezone=Asia%2FSeoul`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const temp = data.current_weather?.temperature;
    const time = data.current_weather?.time;
    let humidity = null;
    if (data.hourly && data.hourly.time && data.hourly.relativehumidity_2m) {
      const idx = data.hourly.time.indexOf(time);
      if (idx >= 0) humidity = data.hourly.relativehumidity_2m[idx];
    }
    return { temp, humidity, raw: data };
  } catch (e) {
    console.error('weather fetch error', e);
    return null;
  }
};

const updateWeatherUI = (name, lat, lon) => {
  const grid = document.querySelector('.weather-grid');
  if (!grid) return;
  fetchWeather(lat, lon).then(result => {
    const temp = result?.temp ?? '정보 없음';
    const humidity = result?.humidity ?? '정보 없음';
    const wbgtApprox = (typeof temp === 'number' && typeof humidity === 'number') ? ( (temp * 0.7) + (humidity * 0.2) ) : null;
    grid.innerHTML = `
      <div class="weather-card">현재 날씨 (${name})<b>☀️ ${temp}℃</b><span style="color:var(--muted);font-size:12px">체감/습도 ${humidity}%</span></div>
      <div class="weather-card">WBGT <span style="color:#d97706">${wbgtApprox ? '(예측)' : ''}</span><b>🌡️ ${wbgtApprox ? wbgtApprox.toFixed(1) + '℃' : '정보 없음'}</b><span class="badge">${wbgtApprox && wbgtApprox>=31? '위험':'주의'}</span></div>
      <div class="weather-card">폭염특보<b style="color:var(--danger)">${(temp>=33)? '폭염주의' : '해당없음'}</b><span style="font-size:12px;color:var(--muted)">${new Date().toLocaleString()}</span></div>
      <div class="weather-card">일출/일몰<b style="font-size:18px">05:22 / 19:42</b></div>
    `;
  }).catch(() => {
    // leave existing content if weather fetch fails
  });
};
const fetchKakaoAddress = async (query) => {
  try {
    const services = await loadKakaoServices();
    const geocoder = new services.Geocoder();
    const addressResult = await new Promise(resolve => {
      geocoder.addressSearch(query, (result, status) => {
        resolve(status === services.Status.OK ? result[0] : null);
      });
    });
    if (addressResult) return addressResult;

    const places = new services.Places();
    const keywordResult = await new Promise(resolve => {
      places.keywordSearch(query, (result, status) => {
        resolve(status === services.Status.OK ? result[0] : null);
      });
    });
    return keywordResult || findLocalAddress(query);
  } catch (error) {
    console.warn('카카오 주소 검색 대신 AWS 자료를 사용합니다.', error);
    return findLocalAddress(query);
  }
};

const fetchKakaoKeyword = async (keyword, x, y, radius = 2000) => {
  try {
    const services = await loadKakaoServices();
    const places = new services.Places();
    return await new Promise(resolve => {
      places.keywordSearch(keyword, (result, status) => {
        resolve(status === services.Status.OK ? result : []);
      }, { x, y, radius, size: 10, sort: services.SortBy.DISTANCE });
    });
  } catch (error) {
    console.warn('카카오 장소 검색을 건너뜁니다.', error);
    return [];
  }
};

const placeScore = (place, keyword) => {
  let score = 50;
  const distance = Number(place.distance || 9999);

  if (distance <= 200) score += 30;
  else if (distance <= 500) score += 20;
  else if (distance <= 1000) score += 10;

  if (keyword === '주차장') score += 25;
  if (keyword === '편의점') score += 18;
  if (keyword === '공원' || keyword === '광장') score += 15;
  if (keyword === '화장실') score += 22;

  if (/주차장|parking/.test(place.place_name)) score += 10;
  if (/공원|광장|쉼터|정자/.test(place.place_name)) score += 8;
  if (/편의점|마트/.test(place.place_name)) score += 6;
  if (/화장실|공중화장실/.test(place.place_name)) score += 8;

  return score;
};

const formatDistance = (distance) => {
  const value = Number(distance || 0);
  if (value < 1000) return `${value}m`;
  return `${(value / 1000).toFixed(1)}km`;
};

const parseCsv = (text) => {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').replace(/^\uFEFF/, '').toLowerCase());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      row[header] = values[idx] ?? '';
    });
    return row;
  });
};

const getAwsStationDistance = (lat, lng) => {
  const pointLat = Number(lat);
  const pointLng = Number(lng);
  if (!awsStations.length || Number.isNaN(pointLat) || Number.isNaN(pointLng)) return null;
  const rad = (deg) => deg * Math.PI / 180;
  const R = 6371e3;
  let best = null;
  awsStations.forEach(station => {
    const sLat = Number(station.latitude);
    const sLng = Number(station.longitude);
    if (Number.isNaN(sLat) || Number.isNaN(sLng)) return;
    const dLat = rad(sLat - pointLat);
    const dLon = rad(sLng - pointLng);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(rad(pointLat)) * Math.cos(rad(sLat)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    if (!best || distance < best.distance) {
      best = { station, distance };
    }
  });
  return best;
};

const buildAwsStationCandidates = (x, y, radius) => {
  const centerLat = Number(y);
  const centerLng = Number(x);
  if (!awsStations.length || Number.isNaN(centerLat) || Number.isNaN(centerLng)) return [];
  const rad = (deg) => deg * Math.PI / 180;
  const R = 6371e3;
  // 시설 API를 사용할 수 없는 GitHub Pages에서도 가까운 실제 AWS 3곳을
  // 추천할 수 있도록 거리순 후보를 항상 계산합니다.
  return awsStations.map(station => {
    const sLat = Number(station.latitude);
    const sLng = Number(station.longitude);
    if (Number.isNaN(sLat) || Number.isNaN(sLng)) return null;
    const dLat = rad(sLat - centerLat);
    const dLon = rad(sLng - centerLng);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(rad(centerLat)) * Math.cos(rad(sLat)) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    return { station, distance };
  }).filter(Boolean).sort((a,b) => a.distance - b.distance).slice(0, 3).map(item => {
    const distance = Math.round(item.distance);
    return {
      place_name: item.station.name || item.station.station_id || 'AWS 관측소',
      address_name: item.station.address || '',
      x: item.station.longitude,
      y: item.station.latitude,
      distance,
      category_name: '관측소/기상대',
      tag: 'AWS 관측소',
      score: Math.max(60, Math.min(100, 100 - Math.round(distance / 2000))),
      stars: Math.max(3, Math.min(5, Math.ceil(Math.max(60, 100 - distance / 2000) / 20))),
      summary: `AWS 관측소 후보 (${formatDistance(distance)})`,
      awsStation: item.station,
      awsDistance: distance,
      key: `${item.station.station_id || item.station.name || 'aws'}|${item.station.address || ''}`
    };
  });
};

const adjustScoreForAwsStation = (place) => {
  const nearest = getAwsStationDistance(place.y, place.x);
  if (!nearest) return { place, awsInfo: null };
  const distance = nearest.distance;
  const bonus = distance <= 2000 ? Math.max(0, 30 - Math.round(distance / 100)) : 0;
  const newPlace = { ...place, awsDistance: distance, awsStation: nearest.station, score: (place.score || 0) + bonus };
  return { place: newPlace, awsInfo: nearest };
};

const fallbackRecommendations = (query) => {
  const prefix = query ? `${query} 주변` : '주변';
  return [
    {
      place_name: `${prefix} 주차장 추천지`,
      address_name: `${query} 지역 내 대표 주차장`,
      distance: 120,
      category_name: '주차장',
      tag: '주차장',
      score: 92,
      stars: 5,
      summary: '접근성이 우수한 주차장 중심 관측 출장 추천지'
    },
    {
      place_name: `${prefix} 광장 추천지`,
      address_name: `${query} 인근 공원/광장`,
      distance: 340,
      category_name: '광장',
      tag: '광장',
      score: 88,
      stars: 4,
      summary: '개방된 공간과 편의시설이 가까운 관측 장소'
    },
    {
      place_name: `${prefix} 편의시설 추천지`,
      address_name: `${query} 지역 내 편의시설 밀집 지역`,
      distance: 500,
      category_name: '편의점',
      tag: '편의점',
      score: 85,
      stars: 4,
      summary: '편의시설과 화장실이 가까운 출장 관측지'
    }
  ];
};

const clearPlaceMarkers = () => {
  if (!map) return;
  Object.values(placeMarkers).forEach(m => {
    try { map.removeLayer(m); } catch (e) {}
  });
  placeMarkers = {};
};

const selectPlace = (place, zoom = 17) => {
  const lat = parseFloat(place.y || place.lat || lastAddress.y);
  const lng = parseFloat(place.x || place.lng || lastAddress.x);
  const name = place.place_name || place.name || place;
  if (!map || isNaN(lat) || isNaN(lng)) return;
  map.setView([lat, lng], zoom);
  const marker = placeMarkers[name];
  if (marker) marker.openPopup();
  else if (mapMarker) mapMarker.setLatLng([lat, lng]).setPopupContent(name).openPopup();
  document.getElementById('selectedPlace').textContent = `(${name})`;
  updateWeatherUI(name, lat, lng);
};

const renderRecommendations = (places) => {
  const container = document.querySelector('.recommendations');
  if (!container) return;

  if (!places.length) {
    container.innerHTML = `<div class="rec-card" style="grid-column:1/-1;text-align:center;padding:40px 20px;">검색 결과가 없습니다. 다른 주소를 입력하고 다시 시도하세요.</div>`;
    clearPlaceMarkers();
    updateComparisonTable([]);
    return;
  }

  container.innerHTML = places.map((place, index) => {
    return `
      <article class="rec-card">
        <div class="rank">${index + 1}</div>
        <div class="rec-title">${place.place_name}</div>
        <div class="rec-address">📍 ${place.address_name || place.road_address_name || '주소 정보 없음'}</div>
        <div class="hero-row">
          <div class="hero-img"><img src="${ getStaticMapUrl(place.x || lastAddress.x || 127.49, place.y || lastAddress.y || 34.95) }" alt="지도 이미지" onerror="this.style.display='none'"/></div>
          <div class="scorebox"><div><div class="score">${place.score}점</div><div class="stars">${'★'.repeat(place.stars)}${'☆'.repeat(5 - place.stars)}</div><div class="badge">${place.tag}</div></div></div>
        </div>
        <div class="metrics">
          <div class="metric">🗺️ 거리<b>${formatDistance(place.distance)}</b></div>
          <div class="metric">🧭 키워드<b>${place.tag}</b></div>
          <div class="metric">📌 카테고리<b>${place.category_name || '기타'}</b></div>
          <div class="metric">✨ 점수<b>${place.score}</b></div>
        </div>
        <div class="features"><span class="feature">${place.summary}</span></div>
        <button class="primary detail-btn" data-place="${place.place_name}" data-x="${place.x || lastAddress.x || ''}" data-y="${place.y || lastAddress.y || ''}">장소 상세보기</button>
      </article>
    `;
  }).join('');
  
  // store current places and add markers for each place and bind click-to-zoom
  currentPlaces = places;
  clearPlaceMarkers();
  places.forEach((place, index) => {
    const lat = parseFloat(place.y || lastAddress.y);
    const lng = parseFloat(place.x || lastAddress.x);
    const name = place.place_name;
    if (!isNaN(lat) && !isNaN(lng) && map) {
      try {
        const marker = L.marker([lat, lng], { icon: createPinIcon({ size: 34, fill: '#1f6fe5' }) }).addTo(map).bindPopup(`<b>${name}</b><br>${place.address_name || ''}`);
        placeMarkers[name] = marker;
        marker.on('click', () => {
          document.getElementById('selectedPlace').textContent = `(${name})`;
          updateWeatherUI(name, lat, lng);
          updateDetailPanel(place);
        });
      } catch (e) { console.error(e); }
    }
    // attach card click to select place (exclude detail button clicks)
    const card = container.querySelectorAll('.rec-card')[index];
    if (card) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('.detail-btn')) return;
        selectPlace(place, 17);
        updateDetailPanel(place);
      });
    }
  });

  // update comparison table to reflect current places
  updateComparisonTable(places.slice(0,3));
};

const updateComparisonTable = (places) => {
  const table = document.querySelector('.rightcol table');
  if (!table) return;
  const head = table.querySelector('thead tr');
  const body = table.querySelector('tbody');
  // rebuild header
  head.innerHTML = '<th>구분</th>' + places.map(p => `<th>${p.place_name}</th>`).join('');
  const rows = [];
  rows.push(['출장 적합도', ...places.map(p => `<b>${p.score}</b>`)]);
  rows.push(['거리', ...places.map(p => formatDistance(p.distance))]);
  rows.push(['카테고리', ...places.map(p => p.category_name || p.tag || '기타')]);
  rows.push(['요약', ...places.map(p => p.summary || '')]);
  rows.push(['추천 등급', ...places.map(p => `<span class="stars">${'★'.repeat(p.stars)}${'☆'.repeat(5 - p.stars)}</span>`)]);

  body.innerHTML = rows.map(r => `<tr>${r.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('');
};

const updateAddressResult = (address) => {
  const text = address.road_address_name || address.address_name || '검색 결과가 없습니다.';
  document.getElementById('addressText').textContent = text;
  document.getElementById('addressText').dataset.x = address.x;
  document.getElementById('addressText').dataset.y = address.y;
  lastAddress = { x: address.x, y: address.y, address_name: text };
  updateMap(address.x, address.y, text);
};

const bindDetailButtons = () => {
  document.querySelectorAll('.detail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.place;
      const x = btn.dataset.x;
      const y = btn.dataset.y;
      document.getElementById('selectedPlace').textContent = `(${name})`;
      document.querySelector('.workspace').scrollIntoView({ behavior: 'smooth' });
      toast(`${name}을 선택했습니다.`);
      // try to find the full place object
      const place = currentPlaces.find(p => p.place_name === name) || null;
      if (place) {
        selectPlace(place, 17);
        updateDetailPanel(place);
      } else if (x && y) {
        updateMap(x, y, name);
        updateWeatherUI(name, y, x);
      }
    });
  });
};

// 출장 메모는 여러 건을 목록으로 쌓아 저장합니다 (observation_support_site/saved.html에서 모아 봅니다).
const MEMO_STORAGE_KEY = 'observationMemos';

const loadMemos = () => {
  try {
    const raw = localStorage.getItem(MEMO_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load saved memos:', e);
  }
  // 이전 버전(단일 메모 1건 저장)과의 호환 — 있으면 목록으로 옮겨줍니다.
  try {
    const legacy = localStorage.getItem('observationMemo');
    if (legacy) {
      const data = JSON.parse(legacy);
      const migrated = [{ id: Date.now(), ...data }];
      localStorage.setItem(MEMO_STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem('observationMemo');
      return migrated;
    }
  } catch (e) {
    console.error('Failed to migrate legacy memo:', e);
  }
  return [];
};

const saveMemos = (list) => {
  localStorage.setItem(MEMO_STORAGE_KEY, JSON.stringify(list));
};

// 마지막으로 저장한 출장 메모(또는 URL의 memoId로 지정한 메모)를 상세 정보 영역에 먼저 보여줍니다.
const restoreSavedMemo = () => {
  const memos = loadMemos();
  if (!memos.length) return;
  const memoId = new URLSearchParams(location.search).get('memoId');
  const data = (memoId && memos.find(m => String(m.id) === memoId)) || memos[memos.length - 1];
  const textarea = document.querySelector('textarea');
  if (textarea && data.content) textarea.value = data.content;
  const selectedPlace = document.getElementById('selectedPlace');
  if (selectedPlace && data.place && data.place !== '미선택') selectedPlace.textContent = data.place;
  toast(`저장된 메모(${data.savedAt})를 불러왔습니다.`);
};

const loadInitialUI = async () => {
  await loadAwsStations();
  document.getElementById('searchBtn').addEventListener('click', async () => {
    const input = document.getElementById('addressInput');
    const query = normalize(input.value) || '광주광역시';
    document.getElementById('addressText').textContent = '검색 중...';
    const sub = document.querySelector('.topbar .sub');
    const radius = getSearchRadius();
    if (sub) sub.textContent = `${query} 기준 검색 반경 ${radius >= 1000 ? (radius/1000)+'km' : radius+'m'}`;

    try {
      const address = await fetchKakaoAddress(query);
      if (address) {
        updateAddressResult(address);
        updateWeatherUI(address.road_address_name || address.address_name || query, address.y, address.x);
        toast('주소 검색이 완료되었습니다.');
      } else {
        document.getElementById('addressText').textContent = '검색 결과가 없습니다.';
        toast('검색 결과가 없습니다. 다른 주소로 시도해주세요.');
      }
    } catch (error) {
      document.getElementById('addressText').textContent = '검색 중 오류가 발생했습니다.';
      toast(error.message);
      console.error(error);
    }
  });

  document.getElementById('recommendBtn').addEventListener('click', async () => {
    const input = document.getElementById('addressInput');
    const query = normalize(input.value) || '광주광역시';
    document.getElementById('addressText').textContent = '추천 장소를 검색 중입니다...';
    toast('추천 장소를 찾는 중입니다.');
    const radius = getSearchRadius();
    try {
      const address = await fetchKakaoAddress(query);
      if (!address) {
        document.getElementById('addressText').textContent = '주소 검색 결과가 없습니다.';
        toast('주소 검색 결과가 없습니다. 주소를 확인하세요.');
        renderRecommendations(fallbackRecommendations(query));
        bindDetailButtons();
        updateHeaderSub(`${query} 기준 검색 반경 ${radius >= 1000 ? (radius/1000)+'km' : radius+'m'}`);
        return;
      }

      updateAddressResult(address);
      const sub = document.querySelector('.topbar .sub');
      if (sub) sub.textContent = `${query} 기준 검색 반경 ${radius >= 1000 ? (radius/1000)+'km' : radius+'m'}`;
      const keywords = ['주차장', '편의점', '광장', '공원'];
      const searches = await Promise.all(keywords.map(keyword => fetchKakaoKeyword(keyword, address.x, address.y, radius)));
      let places = [];

      searches.forEach((items, index) => {
        const keyword = keywords[index];
        items.forEach(item => {
          const key = `${item.place_name}|${item.address_name}|${item.x || ''}|${item.y || ''}`;
          if (!places.some(p => p.key === key)) {
            const basePlace = {
              ...item,
              key,
              tag: keyword,
              score: placeScore(item, keyword),
              stars: Math.min(5, Math.max(1, Math.ceil(placeScore(item, keyword) / 20))),
              summary: `${keyword} 근처 추천 장소, 거리 ${formatDistance(item.distance)}`
            };
            const { place: adjustedPlace } = adjustScoreForAwsStation(basePlace);
            places.push(adjustedPlace);
          }
        });
      });

      places.sort((a, b) => b.score - a.score || a.distance - b.distance);
      const kakaoPick = places.slice(0, 1);
      const awsCandidates = buildAwsStationCandidates(address.x, address.y, radius)
        .filter(candidate => !kakaoPick.some(place => place.key === candidate.key));
      const topPlaces = [...kakaoPick, ...awsCandidates].slice(0, 3);
      if (!topPlaces.length) {
        renderRecommendations(fallbackRecommendations(query));
        toast('검색 결과가 부족하여 기본 추천을 표시합니다.');
      } else {
        renderRecommendations(topPlaces);
        toast(kakaoPick.length ? '카카오 추천 1곳과 가까운 AWS 관측소를 보여드립니다.' : '가까운 실제 AWS 관측소를 보여드립니다.');
      }
      bindDetailButtons();
    } catch (error) {
      document.getElementById('addressText').textContent = '추천 검색 중 오류가 발생했습니다.';
      toast(error.message + ' 기본 추천을 보여드립니다.');
      console.error(error);
      renderRecommendations(fallbackRecommendations(query));
      bindDetailButtons();
    }
  });

  const saveMemoBtn = document.getElementById('saveMemo');
  if (saveMemoBtn) {
    saveMemoBtn.addEventListener('click', () => {
      const textarea = document.querySelector('textarea');
      const selectedPlace = document.getElementById('selectedPlace').textContent || '미선택';
      const memo = textarea ? textarea.value : '';
      const timestamp = new Date().toLocaleString('ko-KR');
      const memoData = {
        id: Date.now(),
        place: selectedPlace,
        content: memo,
        savedAt: timestamp
      };
      try {
        const memos = loadMemos();
        memos.push(memoData);
        saveMemos(memos);
        toast('✅ 출장 메모가 저장되었습니다.');
      } catch (e) {
        console.error('Failed to save memo:', e);
        toast('❌ 메모 저장에 실패했습니다.');
      }
    });
  }

  const pdfBtn = document.getElementById('pdfBtn');
  if (pdfBtn) pdfBtn.addEventListener('click', () => window.print());

  const favBtn = document.getElementById('favBtn');
  if (favBtn) favBtn.addEventListener('click', () => toast('즐겨찾기에 추가했습니다.'));

  const historyBtn = document.getElementById('historyBtn');
  if (historyBtn) historyBtn.addEventListener('click', () => toast('출장 기록 등록 화면을 준비 중입니다.'));

  // AWS CSV upload removed as per requirements

  initMap();
  const defaultQuery = '광주광역시';
  const defaultPlaces = buildAwsStationCandidates(lastAddress.x, lastAddress.y, getSearchRadius());
  renderRecommendations(defaultPlaces.length ? defaultPlaces : fallbackRecommendations(defaultQuery));
  bindDetailButtons();
  const initRadius = getSearchRadius();
  updateHeaderSub(`${defaultQuery} 기준 검색 반경 ${initRadius >= 1000 ? (initRadius/1000)+'km' : initRadius+'m'}`);
  restoreSavedMemo();
};

loadInitialUI();
