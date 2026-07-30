/* 테스트용 Leaflet 대역 — 그리기는 하지 않고 어떤 핀이 올라갔는지만 기록합니다.
   (이 환경에서는 Leaflet CDN이 막혀 있어 실제 지도를 띄울 수 없습니다) */
window.__pins = [];
(function () {
  const latLng = (a, b) => Array.isArray(a) ? { lat: a[0], lng: a[1] } : { lat: a.lat ?? a, lng: a.lng ?? b };
  const L = {
    latLng,
    map: () => ({
      setView() { return this; }, getZoom: () => 9, fitBounds() {}, invalidateSize() {}
    }),
    tileLayer: () => ({ addTo() { return this; } }),
    latLngBounds: pts => ({ pad() { return this; }, pts }),
    divIcon: o => o,
    layerGroup: () => {
      const g = {
        addTo() { return g; },
        clearLayers() { window.__pins.length = 0; }
      };
      return g;
    },
    marker: (pos, opts) => {
      const p = latLng(pos);
      const rec = { lat: p.lat, lng: p.lng, html: opts.icon.html, size: opts.icon.iconSize, tooltip: null, handlers: {} };
      const m = {
        addTo(layer) { window.__pins.push(rec); return m; },
        bindTooltip(t) { rec.tooltip = t; return m; },
        on(ev, fn) { rec.handlers[ev] = fn; return m; },
        getLatLng: () => ({ lat: rec.lat, lng: rec.lng }),
        _rec: rec
      };
      return m;
    }
  };
  window.L = L;
})();
