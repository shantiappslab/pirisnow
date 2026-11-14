// Mapes de la web de PiriSnow (pirineo/web.py el copia a /mapa/mapa.js, al costat de MapLibre GL JS, BSD-3).
// Els mateixos colors, capes i enquadrament que el mapa de pistes de l'app (assets/mapa3d/index.html i PistesMapa.kt).
//
// <div class="mapa" data-mapa="pistes" data-lat data-lon data-nordica>: el mapa de pistes d'una estació (fitxa).
// <div class="mapa" data-mapa="general">: totes les estacions (els punts, a <script type="application/json" id="punts-mapa">).
// Els textos, a <script type="application/json" id="textos-mapa">. Els botons .xip[data-d] ressalten un color
// i .xip[data-pendents] mostra els pendents de més de 30°. El mapa no es carrega fins que es veu.

const ARREL = new URL('.', import.meta.url).href;
const DADES = 'https://shantiappslab.github.io/pirineu/';
const ESTIL = 'https://tiles.openfreemap.org/styles/liberty';
const DEM = {
  type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen, Copernicus EU-DEM, USGS</a>',
};
const COLORS = { verda: '#2E9D4A', blava: '#1E6FD9', vermella: '#D7263D', negra: '#1B1B1B', fora: '#E8871E' };
const colorPista = ['match', ['get', 'd'], ...Object.entries(COLORS).flat(), '#6E7781'];
// Gruix en píxels a z13.5 que creix ×2 per nivell de zoom, com una amplada real en metres. Sobre el relleu,
// MapLibre reaprofita les textures d'abans del zoom i les torna a pintar d'una en una en aturar-se: amb un gruix
// en píxels de pantalla cada rajola saltava de gruix en repintar-se (parpelleig); així la vella i la nova coincideixen.
const gruixZoom = (a, b) => ['interpolate', ['exponential', 2], ['zoom'], 11.5, a, 15.5, b];
const gruix = (px) => gruixZoom(px / 4, px * 4);
const ZOOM_PISTES = 10.5;
const PITCH = 60;

const textos = (() => {
  try { return JSON.parse(document.getElementById('textos-mapa').textContent); } catch (e) { return {}; }
})();

let maplibre = null;
async function carregaMapLibre() {
  if (maplibre) return maplibre;
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = ARREL + 'maplibre-gl.css';
  document.head.append(css);
  maplibre = await import(ARREL + 'maplibre-gl.mjs');
  return maplibre;
}

// El traçat de totes les pistes del Pirineu (el mateix GeoJSON que l'app): un sol cop per pàgina
let pistes = null;
function carregaPistes() {
  pistes ??= fetch(DADES + 'pistes/pirineu.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return pistes;
}

// ── El domini d'una estació (com PistesMapa.limits de l'app) ─────────────────────────────────────────
// La xarxa de línies connectades que surt de les més properes al punt de l'estació; sense els remuntadors de més
// de 2,5 km (telecabines des del poble o entre estacions). Torna [[oest, sud], [est, nord]] o null.
function domini(dades, lat, lon, nordica) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57, ENLLAC = 0.3;
  const linies = [];
  for (const f of dades.features) {
    const t = f.properties.t;
    if (!nordica && t === 'n') continue;
    const c = f.geometry.coordinates;
    const x = c.map((p) => (p[0] - lon) * kx), y = c.map((p) => (p[1] - lat) * ky);
    if (!x.length) continue;
    if (t === 'r') {
      let llarg = 0;
      for (let i = 1; i < x.length; i++) llarg += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
      if (llarg > 2.5) continue;
    }
    let dist = Infinity;
    for (let i = 0; i < x.length; i++) dist = Math.min(dist, Math.hypot(x[i], y[i]));
    if (dist <= 12) linies.push({ x, y, dist });
  }
  if (!linies.length) return null;
  const propera = Math.min(...linies.map((l) => l.dist));
  // Les nòrdiques surten del mateix foyer: més lluny, les línies són d'una altra estació
  if (propera > (nordica ? 2 : 5)) return null;
  const ocupades = new Set();
  const cel = (x, y) => `${Math.floor(x / ENLLAC)},${Math.floor(y / ENLLAC)}`;
  const dins = [];
  const afegeix = (l) => { dins.push(l); l.x.forEach((x, i) => ocupades.add(cel(x, l.y[i]))); };
  const toca = (l) => l.x.some((x, i) => {
    const cx = Math.floor(x / ENLLAC), cy = Math.floor(l.y[i] / ENLLAC);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (ocupades.has(`${cx + dx},${cy + dy}`)) return true;
    return false;
  });
  const llavor = Math.max(1.5, propera);
  let resta = linies.filter((l) => { if (l.dist <= llavor) { afegeix(l); return false; } return true; });
  for (;;) {
    const noves = resta.filter(toca);
    if (!noves.length) break;
    noves.forEach(afegeix);
    resta = resta.filter((l) => !noves.includes(l));
  }
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const l of dins) l.x.forEach((x, i) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, l.y[i]); n = Math.max(n, l.y[i]); });
  return [[lon + w / kx, lat + s / ky], [lon + e / kx, lat + n / ky]];
}

// Rumb que mira cap amunt de les pistes (OSM les dibuixa de dalt a baix): la càmera, a la vall, mirant la muntanya
function rumbPendent(dades, [[w, s], [e, n]]) {
  let x = 0, y = 0;
  const kx = Math.cos((s + n) / 2 * Math.PI / 180);
  for (const f of dades.features) {
    if (f.properties.t !== 'p') continue;
    const c = f.geometry.coordinates;
    const a = c[0], b = c[c.length - 1];
    if (a[1] < s || a[1] > n || a[0] < w || a[0] > e) continue;
    x += (a[0] - b[0]) * kx; y += a[1] - b[1];
  }
  return Math.hypot(x, y) < 1e-6 ? 0 : Math.atan2(x, y) * 180 / Math.PI;
}

// ── Capes ───────────────────────────────────────────────────────────────────────────────────────────
function afegeixRelleu(map) {
  if (!map.getSource('terreny')) {
    map.addSource('terreny', DEM);
    const { attribution, ...sense } = DEM;
    map.addSource('ombra', sense);
    const sota = ['waterway_tunnel', 'waterway_river', 'water'].find((id) => map.getLayer(id));
    map.addLayer({ id: 'relleu', type: 'hillshade', source: 'ombra',
      paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#27313f' } }, sota);
    map.setSky({ 'sky-color': '#9cc7ee', 'horizon-color': '#e8f1f8', 'fog-color': '#e8f1f8',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.6 });
    agrupaVolums(map);
  }
}

// Sobre el relleu, les capes planes es pinten en textures per grups («piles») separats per les capes que no ho
// són (edificis 3D, etiquetes), i cada pila es compon a sobre de l'anterior. Al Pixel (GPU Mali), una pila que no és
// la primera surt esvaïda el fotograma que es torna a pintar, i en fer zoom es tornen a pintar fotograma rere
// fotograma: les pistes parpellejaven. Per això tot el que és pla va en una sola pila: les capes no planes del mapa
// base passen darrere de l'última plana, i les pistes s'hi afegeixen just abans de la primera no plana.
const PLANES = ['background', 'fill', 'line', 'raster', 'hillshade', 'color-relief'];
function agrupaVolums(map) {
  const capes = map.getStyle().layers;
  const ultima = capes.findLastIndex((c) => PLANES.includes(c.type));
  const despres = capes[ultima + 1]?.id;
  for (const c of capes.slice(0, ultima)) {
    if (!PLANES.includes(c.type)) map.moveLayer(c.id, despres);
  }
}
// La primera capa no plana (on comencen les etiquetes): les capes planes noves van just abans
const sobreEtiquetes = (map) => map.getStyle().layers.find((c) => !PLANES.includes(c.type))?.id;

function afegeixPistes(map, dades) {
  map.addSource('pistes', { type: 'geojson', data: dades, maxzoom: 12, tolerance: 0.25, buffer: 128 });
  const es = (t) => ['==', ['get', 't'], t];
  const rodo = { 'line-cap': 'round', 'line-join': 'round' };
  const sota = sobreEtiquetes(map);  // a la pila del mapa base (vegeu agrupaVolums)
  map.addLayer({ id: 'pistes-vora', type: 'line', source: 'pistes', minzoom: ZOOM_PISTES,
    filter: ['any', es('p'), es('n')], layout: rodo,
    paint: { 'line-color': '#ffffff', 'line-width': gruix(7.5), 'line-opacity': 0.85 } }, sota);
  map.addLayer({ id: 'pistes-brillantor', type: 'line', source: 'pistes', minzoom: ZOOM_PISTES,
    filter: ['==', ['get', 'd'], '__cap__'], layout: rodo,
    paint: { 'line-color': colorPista, 'line-width': gruix(17), 'line-blur': gruix(6), 'line-opacity': 0.75 } }, sota);
  map.addLayer({ id: 'pistes-nordiques', type: 'line', source: 'pistes', minzoom: ZOOM_PISTES, filter: es('n'),
    paint: { 'line-color': '#7A4FB0', 'line-width': gruix(2.8), 'line-dasharray': [2, 1.5] } }, sota);
  map.addLayer({ id: 'pistes-linia', type: 'line', source: 'pistes', minzoom: ZOOM_PISTES, filter: es('p'),
    layout: rodo, paint: { 'line-color': colorPista, 'line-width': gruix(5) } }, sota);
  map.addLayer({ id: 'remuntadors', type: 'line', source: 'pistes', minzoom: ZOOM_PISTES, filter: es('r'),
    paint: { 'line-color': '#5B6470', 'line-width': gruix(2.4), 'line-dasharray': [3, 1.5] } }, sota);
  map.addLayer({ id: 'pistes-noms', type: 'symbol', source: 'pistes', minzoom: 13.5, filter: ['has', 'n'],
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5,
      'text-max-angle': 30 },
    paint: { 'text-color': ['case', es('r'), '#5B6470', colorPista], 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } });
}

// Ressalta les pistes d'un color i esvaeix les altres; null les torna totes
function ressalta(map, d) {
  if (!map.getLayer('pistes-linia')) return;
  const si = (a, b) => ['case', ['==', ['get', 'd'], d], a, b];
  map.setPaintProperty('pistes-linia', 'line-opacity', d ? si(1, 0.18) : 1);
  map.setPaintProperty('pistes-vora', 'line-opacity', d ? si(0.95, 0.25) : 0.85);
  map.setPaintProperty('remuntadors', 'line-opacity', d ? 0.35 : 1);
  map.setPaintProperty('pistes-linia', 'line-width', d
    ? gruixZoom(si(7.75 / 4, 3.8 / 4), si(7.75 * 4, 3.8 * 4)) : gruix(5));
  map.setFilter('pistes-brillantor', ['==', ['get', 'd'], d || '__cap__']);
}

// Pendents de més de 30° (teselles del bot, z12–13): sobre el relleu, sota les pistes
function pendents(map, si) {
  if (map.getLayer('pendents')) map.removeLayer('pendents');
  if (map.getSource('pendents')) map.removeSource('pendents');
  if (!si) return;
  map.addSource('pendents', { type: 'raster', tiles: [DADES + 'pendents/{z}/{x}/{y}.png'], tileSize: 256, minzoom: 12, maxzoom: 13 });
  map.addLayer({ id: 'pendents', type: 'raster', source: 'pendents', paint: { 'raster-opacity': 0.7 } },
    map.getLayer('pistes-vora') ? 'pistes-vora' : sobreEtiquetes(map));
}

// Les estacions: un punt del color de l'estat (oberta, tancada) i el nom; en tocar-lo, l'enllaç a la fitxa
function afegeixPunts(map, punts) {
  map.addSource('punts', { type: 'geojson', data: { type: 'FeatureCollection', features: punts.map((p) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { nom: p.nom, url: p.url, color: p.color, estat: p.estat, anell: !!p.anell } })) } });
  map.addLayer({ id: 'punts', type: 'circle', source: 'punts', paint: {
    // Les tancades, anell fosc amb el centre blanc (com a l'app): el gris es perdia sobre el relleu
    'circle-color': ['case', ['get', 'anell'], '#ffffff', ['get', 'color']],
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 11, 8],
    'circle-stroke-color': ['case', ['get', 'anell'], '#3D4A5C', '#ffffff'],
    'circle-stroke-width': ['case', ['get', 'anell'], 2.5, 1.6], 'circle-pitch-alignment': 'viewport' } });
  map.addLayer({ id: 'noms', type: 'symbol', source: 'punts', minzoom: 7, layout: {
    'text-field': ['get', 'nom'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.1],
    'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': '#0E2238', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
}

// ── Un mapa ─────────────────────────────────────────────────────────────────────────────────────────
async function obre(caixa) {
  const { Map, Popup, AttributionControl, NavigationControl, FullscreenControl } = await carregaMapLibre();
  const tipus = caixa.dataset.mapa;
  const lat = parseFloat(caixa.dataset.lat), lon = parseFloat(caixa.dataset.lon);
  const general = tipus === 'general';
  let en3d = caixa.dataset.en3d !== 'no';
  caixa.querySelector('.mapa-carrega')?.remove();
  const lloc = document.createElement('div');
  lloc.className = 'mapa-lloc';
  caixa.prepend(lloc);
  const map = new Map({
    container: lloc, style: ESTIL,
    center: general ? [1.0, 42.65] : [lon, lat], zoom: general ? 6.6 : 12.5,
    pitch: en3d && !general ? PITCH : 0, maxPitch: 75,
    attributionControl: false, cooperativeGestures: true,
    locale: textos.gestos || {},
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2), fadeDuration: 0,
  });
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ visualizePitch: true, showZoom: false }), 'top-right');
  map.addControl(new FullscreenControl({ container: caixa }), 'top-right');
  // L'atribució compacta s'obre sola en carregar i tapa mig mapa: es plega (la «i» la torna a obrir)
  map.once('load', () => caixa.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

  // Inclinada, la GPU agafa un mipmap petit de les textures del relleu i les línies primes s'esvaeixen: anisotròpic
  const gl = map.getCanvas().getContext('webgl2') || map.getCanvas().getContext('webgl');
  const ext = gl && gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) {
    const max = Math.min(gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1, 16);
    const genera = gl.generateMipmap.bind(gl);
    gl.generateMipmap = (t) => { genera(t); gl.texParameterf(t, ext.TEXTURE_MAX_ANISOTROPY_EXT, max); };
  }
  // En aturar-se, MapLibre de vegades deixa les pistes a mig dibuixar fins al fotograma següent: se'n demana un més
  let repintat = false;
  map.on('movestart', () => { repintat = false; });
  map.on('idle', () => { if (!repintat) { repintat = true; setTimeout(() => map.triggerRepaint(), 60); } });

  const estat = { ressalta: null, pendents: false, dades: null };
  map.on('style.load', async () => {
    afegeixRelleu(map);
    if (en3d) map.setTerrain({ source: 'terreny', exaggeration: 1.5 });
    estat.dades = await carregaPistes();
    if (estat.dades) afegeixPistes(map, estat.dades);
    if (general) {
      let punts = [];
      try { punts = JSON.parse(document.getElementById('punts-mapa').textContent); } catch (e) { /* sense punts */ }
      afegeixPunts(map, punts);
      map.fitBounds([[-1.9, 42.25], [3.3, 43.05]], { padding: 20, duration: 0 });
    } else {
      const limits = estat.dades && domini(estat.dades, lat, lon, caixa.dataset.nordica === '1');
      if (!estat.dades || !estat.dades.features.length) caixa.classList.add('sense-pistes');
      else if (!limits) caixa.classList.add('sense-tracat');
      if (limits) {
        const bearing = en3d ? rumbPendent(estat.dades, limits) : 0;
        const cam = map.cameraForBounds(limits, { bearing, padding: 30 });
        if (cam) map.jumpTo({ center: cam.center, zoom: Math.min(cam.zoom + (en3d ? 0.5 : 0), 15.2), bearing, pitch: en3d ? PITCH : 0 });
      }
    }
    ressalta(map, estat.ressalta);
    pendents(map, estat.pendents);
  });

  if (general) {
    map.on('click', 'punts', (ev) => {
      const f = ev.features[0];
      const div = document.createElement('div');
      const b = document.createElement('strong'); b.textContent = f.properties.nom;
      const s = document.createElement('span'); s.textContent = f.properties.estat;
      const a = document.createElement('a'); a.href = f.properties.url; a.textContent = (textos.fitxa || '›');
      div.append(b, s, a);
      new Popup({ closeButton: false, maxWidth: '240px' }).setLngLat(f.geometry.coordinates).setDOMContent(div).addTo(map);
    });
    map.on('mouseenter', 'punts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'punts', () => { map.getCanvas().style.cursor = ''; });
  }

  // 2D / 3D
  const modes = caixa.querySelectorAll('.mapa-modes button');
  const marca = () => modes.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === '3d') === en3d)));
  modes.forEach((b) => b.addEventListener('click', () => {
    en3d = b.dataset.mode === '3d';
    marca();
    if (en3d) {
      map.setTerrain({ source: 'terreny', exaggeration: 1.5 });
      map.easeTo({ pitch: PITCH, zoom: Math.max(map.getZoom(), general ? 8 : map.getZoom()), duration: 900 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  }));
  marca();

  // Els botons de colors i de pendents (a sota del mapa, a la mateixa secció)
  const seccio = caixa.closest('section') || document;
  const resum = seccio.querySelector('.xip-resum');
  seccio.querySelectorAll('.xip[data-d]').forEach((b) => b.addEventListener('click', () => {
    estat.ressalta = estat.ressalta === b.dataset.d ? null : b.dataset.d;
    seccio.querySelectorAll('.xip[data-d]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.d === estat.ressalta)));
    if (resum) resum.textContent = estat.ressalta ? b.dataset.resum || '' : '';
    ressalta(map, estat.ressalta);
  }));
  const xipPendents = seccio.querySelector('.xip[data-pendents]');
  xipPendents?.addEventListener('click', () => {
    estat.pendents = !estat.pendents;
    xipPendents.setAttribute('aria-pressed', String(estat.pendents));
    seccio.querySelector('.llegenda-pendents')?.toggleAttribute('hidden', !estat.pendents);
    pendents(map, estat.pendents);
    if (estat.pendents && map.getZoom() < 12) map.easeTo({ zoom: 12.5, duration: 900 });
  });
  return map;
}

// Es carrega quan s'acosta a la pantalla (MapLibre i les pistes pesen: no a qui no hi arriba)
const caixes = document.querySelectorAll('.mapa[data-mapa]');
if ('IntersectionObserver' in window) {
  const obs = new IntersectionObserver((entrades) => entrades.forEach((en) => {
    if (!en.isIntersecting) return;
    obs.unobserve(en.target);
    obre(en.target).catch((err) => { console.error('mapa', err); en.target.classList.add('mapa-error'); });
  }), { rootMargin: '300px' });
  caixes.forEach((c) => obs.observe(c));
} else {
  caixes.forEach((c) => obre(c).catch(() => c.classList.add('mapa-error')));
}
