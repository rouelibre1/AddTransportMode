'use strict';

/*
 * Liste les séquences Panoramax d'un territoire qui n'ont pas de tag "transport".
 *
 * Fonctionnement :
 *  1. Le contour du territoire (commune / EPCI) est récupéré sur geo.api.gouv.fr.
 *  2. Toutes les séquences dont la géométrie touche l'emprise (bbox) du territoire sont
 *     récupérées via /api/collections?bbox=… (pagination complète).
 *  3. On ne garde que celles sans tag "transport" dans leurs "semantics".
 *  4. Pré-filtre local : l'emprise de la séquence doit toucher le contour du territoire.
 *  5. Option « vérification précise » : pour chaque séquence restante, on demande à son
 *     instance d'origine (POST /api/search, paramètre intersects) si au moins une photo
 *     est dans le contour.
 */

const GEO_API = 'https://geo.api.gouv.fr';
const PAGE_LIMIT = 1000;          // maximum accepté par /api/collections
const PAGE_LIMIT_FALLBACKS = [200, 50]; // tailles de page de repli si le serveur ne répond pas
const RETRY_DELAY_MS = 1000;
const MAX_PAGES = 500;            // garde-fou
const CHECK_CONCURRENCY = 6;      // requêtes simultanées pour la vérification précise
const SIMPLIFY_TOLERANCE = 0.00005; // ~5 m, pour alléger le contour envoyé à l'API
const MAX_MAP_RECTANGLES = 2000;

const $ = (id) => document.getElementById(id);

const els = {
  apiSelect: $('api-select'),
  apiCustom: $('api-custom'),
  territoryType: $('territory-type'),
  territorySearchField: $('territory-search-field'),
  territorySearch: $('territory-search'),
  suggestions: $('territory-suggestions'),
  territorySelected: $('territory-selected'),
  preciseCheck: $('precise-check'),
  form: $('search-form'),
  searchBtn: $('search-btn'),
  cancelBtn: $('cancel-btn'),
  status: $('status'),
  resultsPanel: $('results-panel'),
  minImages: $('min-images'),
  maxImages: $('max-images'),
  sortOrder: $('sort-order'),
  sortHeader: $('sort-header'),
  createdSortHeader: $('created-sort-header'),
  createdSortIndicator: $('created-sort-indicator'),
  uploadDateRanges: $('upload-date-ranges'),
  addUploadDateRange: $('add-upload-date-range'),
  yearFilter: $('year-filter'),
  yearFilterSummary: $('year-filter-summary'),
  yearOptions: $('year-options'),
  yearAll: $('year-all'),
  yearNone: $('year-none'),
  dateRanges: $('date-ranges'),
  addDateRange: $('add-date-range'),
  recheckOpened: $('recheck-opened'),
  toggleTransport: $('toggle-transport'),
  instanceFilter: $('instance-filter'),
  instanceFilterSummary: $('instance-filter-summary'),
  instanceOptions: $('instance-options'),
  instanceAll: $('instance-all'),
  instanceNone: $('instance-none'),
  instanceSortHeader: $('instance-sort-header'),
  instanceSortIndicator: $('instance-sort-indicator'),
  sortIndicator: $('sort-indicator'),
  summary: $('summary'),
  tbody: document.querySelector('#results-table tbody'),
};

const OPENED_STORAGE_KEY = 'addtransportmode:opened-sequences';

function loadOpenedIds() {
  try {
    const list = JSON.parse(localStorage.getItem(OPENED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(list) ? list : []);
  } catch (_) {
    return new Set();
  }
}

function saveOpenedIds() {
  try {
    localStorage.setItem(OPENED_STORAGE_KEY, JSON.stringify([...state.openedIds]));
  } catch (_) { /* stockage indisponible : on garde seulement en mémoire */ }
}

const state = {
  territory: null,      // { type, code, nom, label, geometry, bbox }
  rows: [],             // séquences sans transport retenues
  stats: null,
  abort: null,
  instanceSort: '',     // '' (pas de tri), 'asc' ou 'desc'
  excludedInstances: new Set(), // instances décochées dans le filtre
  excludedYears: new Set(),     // années décochées dans le filtre
  openedIds: loadOpenedIds(),   // séquences dont le lien a été ouvert
  recheckingOpened: false,
  primarySort: 'count',         // 'count' (nombre d'images) ou 'created' (date de mise en ligne)
  createdSort: 'desc',          // sens du tri par date de mise en ligne
  showTransport: false,         // afficher les séquences qui ont déjà transport=
  transportToCheck: [],         // séquences avec transport= pas encore vérifiées précisément
  preciseContext: null,         // { geometry, geometryString } pour la vérification précise
  checkingTransport: false,
};

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

const map = L.map('map').setView([46.6, 2.4], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const territoryLayer = L.geoJSON(null, {
  style: { color: '#1f3a5f', weight: 2, fillOpacity: 0.05 },
}).addTo(map);
const sequencesLayer = L.layerGroup().addTo(map);
const rectangles = new Map(); // id -> L.Rectangle

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function setStatus(message, kind = '', url = null) {
  els.status.textContent = message;
  els.status.className = kind;
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Ouvrir la requête en échec dans un nouvel onglet';
    els.status.append(document.createElement('br'), link);
  }
}

const nf = new Intl.NumberFormat('fr-FR');
const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' });

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : df.format(d);
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Erreur réseau ou réponse sans en-têtes CORS (souvent un délai dépassé côté serveur)
    let host = url;
    try { host = new URL(url).host; } catch (_) { /* ignore */ }
    const netErr = new Error(`impossible d’obtenir une réponse de ${host} (erreur réseau, délai dépassé ou CORS)`);
    netErr.network = true;
    netErr.url = url;
    throw netErr;
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message || body.detail || '';
    } catch (_) { /* ignore */ }
    const err = new Error(`HTTP ${response.status}${detail ? ` : ${detail}` : ''}`);
    err.status = response.status;
    err.url = url;
    throw err;
  }
  return response.json();
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function getApiBase() {
  let value = els.apiSelect.value === 'custom' ? els.apiCustom.value.trim() : els.apiSelect.value;
  value = value.replace(/\/+$/, '');
  if (!value) return null;
  if (!/\/api$/.test(value)) value += '/api';
  return value;
}

/** URL du site web d'une instance, à partir de son URL d'API ou de site. */
function webBaseFromUrl(url) {
  return url.replace(/\/+$/, '').replace(/\/api$/, '');
}

/* ------------------------------------------------------------------ */
/* Géométrie                                                           */
/* ------------------------------------------------------------------ */

/** Liste des polygones (chaque polygone = liste d'anneaux) d'une géométrie GeoJSON. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOfGeometry(geometry) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of polygonsOf(geometry)) {
    for (const [x, y] of poly[0]) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  }
  return [minx, miny, maxx, maxy];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
    && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Indique si un rectangle [minx, miny, maxx, maxy] touche une géométrie (Multi)Polygon.
 * Les trous sont ignorés (le test reste donc permissif).
 */
function bboxIntersectsGeometry(bbox, geometry) {
  const [minx, miny, maxx, maxy] = bbox;
  const corners = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]];
  const rectEdges = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]];
  for (const poly of polygonsOf(geometry)) {
    const ring = poly[0];
    for (const [x, y] of ring) {
      if (x >= minx && x <= maxx && y >= miny && y <= maxy) return true;
    }
    if (corners.some((c) => pointInRing(c, ring))) return true;
    for (let i = 0; i < ring.length - 1; i++) {
      for (const [a, b] of rectEdges) {
        if (segmentsIntersect(ring[i], ring[i + 1], a, b)) return true;
      }
    }
  }
  return false;
}

/** Simplification Douglas-Peucker d'un anneau (reste fermé, au moins 4 points). */
function simplifyRing(ring, tolerance) {
  if (ring.length <= 5) return ring;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let index = -1;
    const [ax, ay] = ring[first];
    const [bx, by] = ring[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = ring[i];
      let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const sq = ex * ex + ey * ey;
      if (sq > maxSq) { maxSq = sq; index = i; }
    }
    if (index !== -1 && maxSq > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

function simplifyGeometry(geometry, tolerance) {
  const simplifyPoly = (poly) => poly.map((ring) => simplifyRing(ring, tolerance));
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: simplifyPoly(geometry.coordinates) };
  if (geometry.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(simplifyPoly) };
  return geometry;
}

function bboxToPolygon([minx, miny, maxx, maxy]) {
  return {
    type: 'Polygon',
    coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]],
  };
}

/* ------------------------------------------------------------------ */
/* Territoires (geo.api.gouv.fr)                                       */
/* ------------------------------------------------------------------ */

async function searchTerritories(type, query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const enc = encodeURIComponent(q);
  const results = [];
  const seen = new Set();
  const add = (items) => {
    for (const item of items) {
      if (!item || seen.has(item.code)) continue;
      seen.add(item.code);
      results.push(item);
    }
  };

  if (type === 'commune') {
    const fields = 'fields=nom,code,codeDepartement,codesPostaux,population';
    const requests = [];
    if (/^\d{5}$/.test(q) || /^2[ab]\d{3}$/i.test(q)) {
      requests.push(fetchJson(`${GEO_API}/communes?code=${enc}&${fields}`).catch(() => []));
      requests.push(fetchJson(`${GEO_API}/communes?codePostal=${enc}&${fields}`).catch(() => []));
    } else {
      requests.push(fetchJson(`${GEO_API}/communes?nom=${enc}&${fields}&boost=population&limit=15`));
    }
    for (const list of await Promise.all(requests)) add(list);
    return results.map((c) => ({
      type: 'commune',
      code: c.code,
      nom: c.nom,
      label: c.nom,
      hint: `${c.codeDepartement || ''} · INSEE ${c.code}${c.codesPostaux && c.codesPostaux.length ? ` · CP ${c.codesPostaux.slice(0, 3).join(', ')}` : ''}`,
    }));
  }

  if (type === 'epci') {
    const fields = 'fields=nom,code,population';
    if (/^\d{9}$/.test(q)) {
      const epci = await fetchJson(`${GEO_API}/epcis/${enc}?${fields}`).catch(() => null);
      add(epci ? [epci] : []);
    } else {
      add(await fetchJson(`${GEO_API}/epcis?nom=${enc}&${fields}&limit=15`));
    }
    return results.map((e) => ({
      type: 'epci',
      code: e.code,
      nom: e.nom,
      label: e.nom,
      hint: `SIREN ${e.code}${e.population ? ` · ${nf.format(e.population)} hab.` : ''}`,
    }));
  }
  return [];
}

async function loadTerritoryGeometry(territory) {
  const path = territory.type === 'commune' ? 'communes' : 'epcis';
  const data = await fetchJson(`${GEO_API}/${path}/${encodeURIComponent(territory.code)}?fields=nom,code,contour`);
  if (!data.contour) throw new Error(`Aucun contour disponible pour ${territory.nom}.`);
  return { ...territory, geometry: data.contour, bbox: bboxOfGeometry(data.contour) };
}

function showSuggestions(items) {
  els.suggestions.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aucun résultat';
    els.suggestions.append(li);
  }
  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label + ' ';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = item.hint;
    btn.append(hint);
    btn.addEventListener('click', () => selectTerritory(item));
    li.append(btn);
    els.suggestions.append(li);
  }
  els.suggestions.hidden = false;
}

function hideSuggestions() {
  els.suggestions.hidden = true;
}

async function selectTerritory(item) {
  hideSuggestions();
  els.territorySearch.value = item.label;
  els.territorySelected.textContent = `Chargement du contour de ${item.label}…`;
  try {
    const territory = await loadTerritoryGeometry(item);
    state.territory = territory;
    els.territorySelected.textContent = `✔ ${territory.label} (${territory.type === 'commune' ? 'commune' : 'EPCI'} ${territory.code})`;
    territoryLayer.clearLayers();
    territoryLayer.addData(territory.geometry);
    map.fitBounds(territoryLayer.getBounds(), { padding: [20, 20] });
  } catch (err) {
    state.territory = null;
    els.territorySelected.textContent = '';
    setStatus(`Impossible de charger le territoire : ${err.message}`, 'error');
  }
}

const onTerritoryInput = debounce(async () => {
  const type = els.territoryType.value;
  const query = els.territorySearch.value;
  if (query.trim().length < 2) { hideSuggestions(); return; }
  try {
    const items = await searchTerritories(type, query);
    // ignore les réponses obsolètes
    if (els.territorySearch.value === query && els.territoryType.value === type) showSuggestions(items);
  } catch (err) {
    setStatus(`Recherche de territoire impossible : ${err.message}`, 'error');
  }
}, 250);

/* ------------------------------------------------------------------ */
/* Panoramax                                                           */
/* ------------------------------------------------------------------ */

/**
 * Récupère toutes les séquences dont la géométrie touche la bbox.
 * Les liens "next" de l'API ne conservent pas le paramètre bbox : on reprend
 * uniquement leurs paramètres de pagination (page, sortby) et on rajoute bbox/limit.
 */
function isRetryable(err) {
  return err.network || err.status === 429 || (err.status >= 500 && err.status < 600);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

async function fetchAllCollections(apiBase, bbox, signal, onProgress, onRetry) {
  const all = new Map();
  let pagination = null;
  // Tailles de page essayées successivement si le serveur ne répond pas
  // (requête trop lourde -> délai dépassé côté serveur).
  const limits = [PAGE_LIMIT, ...PAGE_LIMIT_FALLBACKS];
  let limitIndex = 0;
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const limit = limits[limitIndex];
    const url = new URL(`${apiBase}/collections`);
    url.searchParams.set('bbox', bbox.map((v) => v.toFixed(6)).join(','));
    url.searchParams.set('limit', String(limit));
    if (pagination) {
      for (const [key, value] of Object.entries(pagination)) url.searchParams.set(key, value);
    }
    let data;
    try {
      data = await fetchJson(url.toString(), { signal });
    } catch (err) {
      if (err.name === 'AbortError' || !isRetryable(err) || limitIndex >= limits.length - 1) throw err;
      limitIndex++;
      onRetry(limits[limitIndex], err);
      await wait(RETRY_DELAY_MS, signal);
      pageNumber--; // on retente la même page
      continue;
    }
    const collections = Array.isArray(data.collections) ? data.collections : [];
    for (const c of collections) {
      if (c && c.id && c['geovisio:status'] !== 'deleted') all.set(c.id, c);
    }
    onProgress(pageNumber, all.size);

    const next = (data.links || []).find((l) => l.rel === 'next');
    if (collections.length < limit || !next || !next.href) break;
    const nextParams = new URL(next.href, url).searchParams;
    const newPagination = {};
    for (const key of ['page', 'sortby']) {
      if (nextParams.has(key)) newPagination[key] = nextParams.get(key);
    }
    if (!newPagination.page || (pagination && pagination.page === newPagination.page)) break;
    pagination = newPagination;
  }
  return [...all.values()];
}

function hasTransportTag(collection) {
  const semantics = Array.isArray(collection.semantics) ? collection.semantics : [];
  return semantics.some((tag) => tag
    && String(tag.key || '').trim().toLowerCase() === 'transport'
    && String(tag.value ?? '').trim() !== '');
}

function collectionBbox(collection) {
  const b = collection.extent && collection.extent.spatial && collection.extent.spatial.bbox;
  const box = Array.isArray(b) && Array.isArray(b[0]) ? b[0] : b;
  return Array.isArray(box) && box.length >= 4 ? box.slice(0, 4).map(Number) : null;
}

function instanceInfo(collection, apiBase) {
  const via = (collection.links || []).find((l) => l.rel === 'via' && l.href);
  if (via) {
    let name = via.instance_name;
    const web = webBaseFromUrl(via.href);
    if (!name) {
      try { name = new URL(web).host; } catch (_) { name = web; }
    }
    return { name, web };
  }
  const web = webBaseFromUrl(apiBase);
  let name;
  try { name = new URL(web).host; } catch (_) { name = web; }
  return { name, web };
}

function toRow(collection, apiBase) {
  const count = collection['stats:items'] && collection['stats:items'].count;
  const interval = collection.extent && collection.extent.temporal && collection.extent.temporal.interval;
  const start = Array.isArray(interval) && Array.isArray(interval[0]) ? interval[0][0] : null;
  const provider = Array.isArray(collection.providers) && collection.providers.length ? collection.providers[0].name : '';
  const semantics = Array.isArray(collection.semantics) ? collection.semantics : [];
  const instance = instanceInfo(collection, apiBase);
  return {
    id: collection.id,
    title: collection.title || collection.id,
    count: Number.isFinite(Number(count)) && count !== null ? Number(count) : null,
    date: start,
    created: collection.created || null, // date de mise en ligne
    provider,
    tags: semantics.map((t) => `${t.key}=${t.value}`),
    bbox: collectionBbox(collection),
    instanceName: instance.name,
    instanceWeb: instance.web,
    verified: null, // true = vérifiée dans le contour, false = vérification impossible
    hasTransport: hasTransportTag(collection),
    recheck: null,  // null | 'loading' | 'present' | 'absent' | 'missing' | 'error'
    recheckMessage: '',
  };
}

async function postSearch(url, body, signal) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/** Demande à l'instance d'origine si la séquence a au moins une photo dans le contour. */
async function sequenceIntersects(row, geometry, geometryString, signal) {
  const url = `${row.instanceWeb}/api/search`;
  try {
    // GeoVisio attend en POST un "intersects" sous forme de chaîne JSON
    const data = await postSearch(url, { intersects: geometryString, collections: [row.id], limit: 1 }, signal);
    return (data.features || []).length > 0;
  } catch (err) {
    if (err.status !== 400) throw err;
    // repli : format STAC standard (objet GeoJSON)
    const data = await postSearch(url, { intersects: geometry, collections: [row.id], limit: 1 }, signal);
    return (data.features || []).length > 0;
  }
}

/**
 * Vérification précise d'un lot de séquences : garde celles qui ont au moins une photo
 * dans le contour (et celles dont la vérification a échoué, marquées verified=false).
 */
async function preciseFilter(rows, signal, onProgress) {
  const { geometry, geometryString } = state.preciseContext;
  const kept = [];
  let failures = 0;
  let done = 0;
  await runPool(rows, CHECK_CONCURRENCY, async (row) => {
    try {
      if (await sequenceIntersects(row, geometry, geometryString, signal)) {
        row.verified = true;
        kept.push(row);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      failures++;
      row.verified = false;
      kept.push(row);
    }
    done++;
    onProgress(done, rows.length);
  });
  return { kept, failures };
}

/** Vérifie précisément (une seule fois) les séquences avec transport= avant de les afficher. */
async function checkTransportRows() {
  const rows = state.transportToCheck;
  if (!rows.length || !state.preciseContext || state.checkingTransport) return;
  state.checkingTransport = true;
  els.toggleTransport.disabled = true;
  try {
    const { kept, failures } = await preciseFilter(rows, undefined, (done, total) => {
      els.toggleTransport.textContent = `Vérification précise… ${nf.format(done)} / ${nf.format(total)}`;
    });
    state.transportToCheck = [];
    state.rows = state.rows.concat(kept);
    if (failures) {
      setStatus(`${nf.format(failures)} séquence(s) avec transport= n’ont pas pu être vérifiées précisément (conservées dans la liste).`, 'warning');
    }
  } catch (err) {
    setStatus(`Erreur : ${err.message}`, 'error', err.url || null);
  } finally {
    state.checkingTransport = false;
    els.toggleTransport.disabled = false;
  }
}

async function toggleTransport() {
  state.showTransport = !state.showTransport;
  if (state.showTransport && state.transportToCheck.length) {
    render();
    await checkTransportRows();
  }
  render();
}

function updateToggleTransportButton() {
  if (state.checkingTransport) return;
  const n = state.rows.filter((r) => r.hasTransport).length + state.transportToCheck.length;
  els.toggleTransport.textContent = `${state.showTransport ? 'Masquer' : 'Afficher'} les séquences avec transport= (${nf.format(n)})`;
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ */
/* Recherche                                                           */
/* ------------------------------------------------------------------ */

async function runSearch() {
  const apiBase = getApiBase();
  if (!apiBase) { setStatus('Indiquez l’URL de l’API Panoramax.', 'error'); return; }

  let territory;
  if (els.territoryType.value === 'map') {
    const b = map.getBounds();
    const bbox = [
      Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()),
      Math.min(180, b.getEast()), Math.min(90, b.getNorth()),
    ];
    territory = { type: 'map', label: 'emprise de la carte', geometry: bboxToPolygon(bbox), bbox };
    territoryLayer.clearLayers();
    territoryLayer.addData(territory.geometry);
  } else {
    territory = state.territory;
    if (!territory || territory.type !== els.territoryType.value) {
      setStatus('Choisissez un territoire dans la liste de suggestions.', 'error');
      return;
    }
  }

  const controller = new AbortController();
  state.abort = controller;
  els.searchBtn.disabled = true;
  els.cancelBtn.hidden = false;
  sequencesLayer.clearLayers();
  rectangles.clear();

  try {
    setStatus('Récupération des séquences…');
    const collections = await fetchAllCollections(apiBase, territory.bbox, controller.signal, (page, total) => {
      setStatus(`Récupération des séquences… page ${page}, ${nf.format(total)} séquence(s) dans l’emprise.`);
    }, (newLimit) => {
      setStatus(`Le serveur n’a pas répondu, nouvel essai avec des pages de ${newLimit} séquences…`, 'warning');
    });

    const withoutSemantics = collections.filter((c) => !Array.isArray(c.semantics)).length;
    const inTerritory = collections.filter((c) => {
      const box = collectionBbox(c);
      return !box || bboxIntersectsGeometry(box, territory.geometry);
    });
    const allRows = inTerritory.map((c) => toRow(c, apiBase));
    let rows = allRows.filter((r) => !r.hasTransport);
    let transportRows = allRows.filter((r) => r.hasTransport);
    state.transportToCheck = [];
    state.preciseContext = null;

    let failures = 0;
    if (els.preciseCheck.checked && territory.type !== 'map') {
      const simplified = simplifyGeometry(territory.geometry, SIMPLIFY_TOLERANCE);
      state.preciseContext = { geometry: simplified, geometryString: JSON.stringify(simplified) };
      if (rows.length) {
        const result = await preciseFilter(rows, controller.signal, (done, total) => {
          setStatus(`Vérification précise… ${nf.format(done)} / ${nf.format(total)}`);
        });
        rows = result.kept;
        failures = result.failures;
      }
      // les séquences avec transport= ne seront vérifiées qu'à leur premier affichage
      state.transportToCheck = transportRows;
      transportRows = [];
    }

    state.rows = rows.concat(transportRows);
    state.stats = {
      territory,
      fetched: collections.length,
      inTerritory: inTerritory.length,
      failures,
      withoutSemantics,
      precise: els.preciseCheck.checked && territory.type !== 'map',
    };

    const messages = [`Recherche terminée : ${nf.format(rows.length)} séquence(s) sans transport.`];
    if (state.showTransport && state.transportToCheck.length) await checkTransportRows();
    let kind = '';
    if (failures) {
      messages.push(`${nf.format(failures)} séquence(s) n’ont pas pu être vérifiées précisément (conservées dans la liste).`);
      kind = 'warning';
    }
    if (withoutSemantics && withoutSemantics === collections.length) {
      messages.push('Attention : cette API ne renvoie pas les tags des séquences, le filtre sur transport= n’est pas fiable.');
      kind = 'warning';
    }
    setStatus(messages.join(' '), kind);
    els.resultsPanel.hidden = false;
    render();
  } catch (err) {
    if (err.name === 'AbortError') setStatus('Recherche annulée.', 'warning');
    else setStatus(`Erreur : ${err.message}`, 'error', err.url || null);
  } finally {
    state.abort = null;
    els.searchBtn.disabled = false;
    els.cancelBtn.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Affichage des résultats                                             */
/* ------------------------------------------------------------------ */

function readIntInput(input) {
  const v = input.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const NO_DATE = 'sans-date';

/**
 * Remplit un menu à cases à cocher. entries : [{ value, label, count }].
 * Les valeurs décochées sont mémorisées dans `excluded` (conservées si toujours présentes).
 */
function fillMultiSelect(container, entries, excluded) {
  const values = new Set(entries.map((e) => e.value));
  for (const v of [...excluded]) if (!values.has(v)) excluded.delete(v);
  container.innerHTML = '';
  for (const entry of entries) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = entry.value;
    box.checked = !excluded.has(entry.value);
    box.addEventListener('change', () => {
      if (box.checked) excluded.delete(entry.value);
      else excluded.add(entry.value);
      render();
    });
    label.append(box, `${entry.label} (${nf.format(entry.count)})`);
    container.append(label);
  }
}

function setAllOptions(container, excluded, checked) {
  for (const box of container.querySelectorAll('input[type="checkbox"]')) {
    box.checked = checked;
    if (checked) excluded.delete(box.value);
    else excluded.add(box.value);
  }
  render();
}

function multiSelectSummary(container, excluded) {
  const total = container.querySelectorAll('input').length;
  const selected = total - excluded.size;
  return selected === total ? `Toutes (${nf.format(total)})`
    : selected === 0 ? 'Aucune' : `${nf.format(selected)} sur ${nf.format(total)}`;
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

function rowYear(row) {
  const day = localIsoDate(row.date);
  return day ? day.slice(0, 4) : NO_DATE;
}

/** Remplit les menus Instances et Années à partir des résultats. */
function fillResultFilters() {
  const base = state.rows.filter((r) => state.showTransport || !r.hasTransport);
  const instances = countBy(base, (r) => r.instanceName);
  fillMultiSelect(els.instanceOptions, [...instances.keys()].sort((a, b) => a.localeCompare(b, 'fr'))
    .map((name) => ({ value: name, label: name, count: instances.get(name) })), state.excludedInstances);

  const years = countBy(base, rowYear);
  const yearValues = [...years.keys()].filter((y) => y !== NO_DATE).sort();
  if (years.has(NO_DATE)) yearValues.push(NO_DATE);
  fillMultiSelect(els.yearOptions, yearValues
    .map((y) => ({ value: y, label: y === NO_DATE ? 'Sans date' : y, count: years.get(y) })), state.excludedYears);
}

/* Plages de dates multiples */

function addDateRangeRow(container, from = '', to = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'date-range';
  const fromLabel = document.createElement('label');
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.className = 'range-from';
  fromInput.value = from;
  fromLabel.append('du ', fromInput);
  const toLabel = document.createElement('label');
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.className = 'range-to';
  toInput.value = to;
  toLabel.append('au ', toInput);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small-btn';
  remove.textContent = '✕';
  remove.title = 'Supprimer cette plage';
  remove.addEventListener('click', () => {
    wrapper.remove();
    if (!container.children.length) addDateRangeRow(container);
    render();
  });
  fromInput.addEventListener('input', render);
  toInput.addEventListener('input', render);
  wrapper.append(fromLabel, toLabel, remove);
  container.append(wrapper);
}

/** Plages renseignées (au moins une borne). */
function activeDateRanges(container) {
  return [...container.querySelectorAll('.date-range')]
    .map((w) => ({ from: w.querySelector('.range-from').value || null, to: w.querySelector('.range-to').value || null }))
    .filter((r) => r.from || r.to);
}

/** Date locale AAAA-MM-JJ (même jour que celui affiché dans le tableau). */
function localIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeOf(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Compare deux nombres ; les valeurs inconnues (null) sont toujours à la fin. */
function compareNullable(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

function filteredSortedRows() {
  const min = readIntInput(els.minImages);
  const max = readIntInput(els.maxImages);
  const dir = els.sortOrder.value === 'asc' ? 1 : -1;
  const ranges = activeDateRanges(els.dateRanges);
  const uploadRanges = activeDateRanges(els.uploadDateRanges);
  const createdDir = state.createdSort === 'asc' ? 1 : -1;
  const instanceDir = state.instanceSort === 'asc' ? 1 : state.instanceSort === 'desc' ? -1 : 0;
  return state.rows
    .filter((r) => {
      if (!state.showTransport && r.hasTransport) return false;
      if (state.excludedInstances.has(r.instanceName)) return false;
      if (state.excludedYears.has(rowYear(r))) return false;
      if (ranges.length) {
        const day = localIsoDate(r.date);
        if (!day) return false;
        if (!ranges.some((rg) => (!rg.from || day >= rg.from) && (!rg.to || day <= rg.to))) return false;
      }
      if (uploadRanges.length) {
        const day = localIsoDate(r.created);
        if (!day) return false;
        if (!uploadRanges.some((rg) => (!rg.from || day >= rg.from) && (!rg.to || day <= rg.to))) return false;
      }
      if (min === null && max === null) return true;
      if (r.count === null) return false;
      if (min !== null && r.count < min) return false;
      if (max !== null && r.count > max) return false;
      return true;
    })
    .sort((a, b) => {
      if (instanceDir) {
        const byInstance = a.instanceName.localeCompare(b.instanceName, 'fr') * instanceDir;
        if (byInstance) return byInstance;
      }
      if (state.primarySort === 'created') {
        return compareNullable(timeOf(a.created), timeOf(b.created), createdDir)
          || compareNullable(a.count, b.count, dir);
      }
      return compareNullable(a.count, b.count, dir)
        || String(a.date || '').localeCompare(String(b.date || ''));
    });
}

function openedRows() {
  return state.rows.filter((r) => state.openedIds.has(r.id));
}

function updateRecheckOpenedButton() {
  if (state.recheckingOpened) return;
  const n = openedRows().length;
  els.recheckOpened.textContent = `Revérifier les séquences ouvertes (${nf.format(n)})`;
  els.recheckOpened.disabled = n === 0;
}

function markOpened(row) {
  if (state.openedIds.has(row.id)) return;
  state.openedIds.add(row.id);
  saveOpenedIds();
  // pas de render() ici : on ne reconstruit pas le lien pendant son clic
  updateRecheckOpenedButton();
}

/** Revérifie toutes les séquences des résultats dont le lien a été ouvert. */
async function recheckOpenedRows() {
  const rows = openedRows();
  if (!rows.length || state.recheckingOpened) return;
  state.recheckingOpened = true;
  els.recheckOpened.disabled = true;
  let done = 0;
  els.recheckOpened.textContent = `Vérification… 0 / ${nf.format(rows.length)}`;
  await runPool(rows, CHECK_CONCURRENCY, async (row) => {
    await recheckRow(row);
    done++;
    els.recheckOpened.textContent = `Vérification… ${nf.format(done)} / ${nf.format(rows.length)}`;
  });
  state.recheckingOpened = false;
  const present = rows.filter((r) => r.recheck === 'present').length;
  updateRecheckOpenedButton();
  setStatus(`Revérification terminée : ${nf.format(present)} séquence(s) sur ${nf.format(rows.length)} ont maintenant un tag transport=.`
    + (present && !state.showTransport ? ' Elles sont masquées avec les autres séquences qui ont ce tag.' : ''));
}

/** Relit la séquence sur son instance d'origine et indique si le tag transport est désormais présent. */
async function recheckRow(row) {
  row.recheck = 'loading';
  render();
  const url = `${row.instanceWeb}/api/collections/${encodeURIComponent(row.id)}`;
  try {
    const collection = await fetchJson(url, { cache: 'no-store' });
    if (collection['geovisio:status'] === 'deleted') {
      row.recheck = 'missing';
      row.recheckMessage = 'Séquence supprimée ou masquée';
    } else {
      const semantics = Array.isArray(collection.semantics) ? collection.semantics : [];
      row.tags = semantics.map((t) => `${t.key}=${t.value}`);
      const transport = semantics.find((t) => t && String(t.key || '').trim().toLowerCase() === 'transport'
        && String(t.value ?? '').trim() !== '');
      row.hasTransport = Boolean(transport);
      if (transport) {
        row.recheck = 'present';
        row.recheckMessage = `✔ transport=${transport.value}`;
      } else {
        row.recheck = 'absent';
        row.recheckMessage = 'Toujours sans transport';
      }
      if (transport && !state.showTransport && !state.recheckingOpened) {
        setStatus(`« ${row.title} » a maintenant transport=${transport.value} : elle est masquée avec les autres séquences qui ont ce tag.`);
      }
    }
  } catch (err) {
    if (err.status === 404) {
      row.recheck = 'missing';
      row.recheckMessage = 'Séquence introuvable';
    } else {
      row.recheck = 'error';
      row.recheckMessage = `Échec : ${err.message}`;
    }
  }
  render();
}

function highlightRow(id, on) {
  const tr = els.tbody.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  if (tr) tr.classList.toggle('highlight', on);
  const rect = rectangles.get(id);
  if (rect) rect.setStyle(on ? { color: '#d97706', weight: 3 } : { color: '#c2410c', weight: 1 });
}

function zoomTo(row) {
  if (!row.bbox) return;
  const [minx, miny, maxx, maxy] = row.bbox;
  map.fitBounds([[miny, minx], [maxy, maxx]], { padding: [30, 30], maxZoom: 18 });
  document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function render() {
  fillResultFilters();
  updateToggleTransportButton();
  const rows = filteredSortedRows();
  els.sortIndicator.textContent = els.sortOrder.value === 'asc' ? '▲' : '▼';
  els.sortIndicator.classList.toggle('inactive', state.primarySort !== 'count');
  els.createdSortIndicator.textContent = state.createdSort === 'asc' ? '▲' : '▼';
  els.createdSortIndicator.classList.toggle('inactive', state.primarySort !== 'created');
  els.instanceSortIndicator.textContent = state.instanceSort === 'desc' ? '▼' : '▲';
  els.instanceSortIndicator.classList.toggle('inactive', !state.instanceSort);
  els.instanceFilterSummary.textContent = multiSelectSummary(els.instanceOptions, state.excludedInstances);
  els.yearFilterSummary.textContent = multiSelectSummary(els.yearOptions, state.excludedYears);
  updateRecheckOpenedButton();

  const s = state.stats;
  const totalImages = rows.reduce((sum, r) => sum + (r.count || 0), 0);
  if (s) {
    const where = s.territory.type === 'map' ? 'l’emprise de la carte' : s.territory.label;
    const withTransport = state.rows.filter((r) => r.hasTransport).length;
    const withoutTransport = state.rows.length - withTransport;
    const transportPart = state.transportToCheck.length
      ? `${nf.format(state.transportToCheck.length)} séquence(s) de l’emprise ont déjà un tag transport= (pas encore vérifiées précisément).`
      : `${nf.format(withTransport)} séquence(s) de la zone ont déjà un tag transport=${state.showTransport ? '' : ' (masquées)'}.`;
    els.summary.textContent =
      `${nf.format(rows.length)} séquence(s) affichée(s) (${nf.format(totalImages)} images). `
      + `${nf.format(withoutTransport)} séquence(s) sans transport= dans ${where}. `
      + transportPart
      + (s.precise ? '' : ' Sélection basée sur l’emprise des séquences (sans vérification précise).');
  }

  els.tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    if (row.recheck === 'present') tr.classList.add('rechecked-ok');
    else if (row.hasTransport) tr.classList.add('has-transport');

    const tdCount = document.createElement('td');
    tdCount.className = 'num';
    tdCount.textContent = row.count === null ? '?' : nf.format(row.count);

    const tdTitle = document.createElement('td');
    const titleLink = document.createElement('a');
    titleLink.href = `${row.instanceWeb}/sequence/${encodeURIComponent(row.id)}`;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = row.title;
    const idSpan = document.createElement('span');
    idSpan.className = 'seq-id';
    idSpan.textContent = row.id;
    tdTitle.append(titleLink, idSpan);
    if (row.verified === false) {
      const warn = document.createElement('span');
      warn.className = 'unverified';
      warn.textContent = 'non vérifiée précisément';
      tdTitle.append(warn);
    }

    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(row.date);

    const tdCreated = document.createElement('td');
    tdCreated.textContent = formatDate(row.created);

    const tdProvider = document.createElement('td');
    tdProvider.textContent = row.provider;

    const tdTags = document.createElement('td');
    const tags = document.createElement('span');
    tags.className = 'tags';
    tags.textContent = row.tags.length ? row.tags.join(', ') : '—';
    tdTags.append(tags);

    const tdInstance = document.createElement('td');
    tdInstance.textContent = row.instanceName;

    const tdActions = document.createElement('td');
    tdActions.className = 'row-actions';
    const edit = document.createElement('a');
    edit.href = titleLink.href;
    edit.target = '_blank';
    edit.rel = 'noopener';
    edit.textContent = 'Modifier les tags';
    tdActions.append(edit);
    if (row.bbox) {
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.textContent = 'Carte';
      zoom.addEventListener('click', () => zoomTo(row));
      tdActions.append(zoom);
    }
    const recheck = document.createElement('button');
    recheck.type = 'button';
    recheck.className = 'recheck-btn';
    recheck.textContent = row.recheck === 'loading' ? 'Vérification…' : 'Revérifier';
    recheck.disabled = row.recheck === 'loading';
    recheck.title = 'Revérifier la présence du tag transport sur l’instance d’origine';
    recheck.addEventListener('click', () => recheckRow(row));
    tdActions.append(recheck);
    if (row.recheck && row.recheck !== 'loading') {
      const result = document.createElement('span');
      result.className = `recheck-result ${row.recheck}`;
      result.textContent = row.recheckMessage;
      tdActions.append(result);
    }

    tr.append(tdCount, tdTitle, tdDate, tdCreated, tdProvider, tdTags, tdInstance, tdActions);
    for (const link of [titleLink, edit]) {
      // clic gauche, clic molette ou menu contextuel « ouvrir dans un nouvel onglet »
      link.addEventListener('click', () => markOpened(row));
      link.addEventListener('auxclick', () => markOpened(row));
      link.addEventListener('contextmenu', () => markOpened(row));
    }
    tr.addEventListener('mouseenter', () => highlightRow(row.id, true));
    tr.addEventListener('mouseleave', () => highlightRow(row.id, false));
    fragment.append(tr);
  }
  els.tbody.append(fragment);

  // carte : emprise des séquences affichées
  sequencesLayer.clearLayers();
  rectangles.clear();
  for (const row of rows.slice(0, MAX_MAP_RECTANGLES)) {
    if (!row.bbox) continue;
    const [minx, miny, maxx, maxy] = row.bbox;
    const rect = L.rectangle([[miny, minx], [maxy, maxx]], { color: '#c2410c', weight: 1, fillOpacity: 0.05 });
    rect.bindTooltip(`${row.title} — ${row.count === null ? '?' : nf.format(row.count)} images`);
    rect.on('mouseover', () => highlightRow(row.id, true));
    rect.on('mouseout', () => highlightRow(row.id, false));
    rect.on('click', () => {
      const tr = els.tbody.querySelector(`tr[data-id="${CSS.escape(row.id)}"]`);
      if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    rect.addTo(sequencesLayer);
    rectangles.set(row.id, rect);
  }
}

/* ------------------------------------------------------------------ */
/* Évènements                                                          */
/* ------------------------------------------------------------------ */

els.apiSelect.addEventListener('change', () => {
  els.apiCustom.hidden = els.apiSelect.value !== 'custom';
});

els.territoryType.addEventListener('change', () => {
  const isMap = els.territoryType.value === 'map';
  els.territorySearchField.hidden = isMap;
  els.territorySearch.value = '';
  els.territorySelected.textContent = '';
  state.territory = null;
  territoryLayer.clearLayers();
  hideSuggestions();
});

els.territorySearch.addEventListener('input', onTerritoryInput);
els.territorySearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSuggestions();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete')) hideSuggestions();
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.abort) runSearch();
});
els.cancelBtn.addEventListener('click', () => {
  if (state.abort) state.abort.abort();
});

els.minImages.addEventListener('input', render);
els.maxImages.addEventListener('input', render);
els.sortOrder.addEventListener('change', () => {
  state.primarySort = 'count';
  render();
});
els.yearAll.addEventListener('click', () => setAllOptions(els.yearOptions, state.excludedYears, true));
els.yearNone.addEventListener('click', () => setAllOptions(els.yearOptions, state.excludedYears, false));
els.addDateRange.addEventListener('click', () => addDateRangeRow(els.dateRanges));
addDateRangeRow(els.dateRanges);
els.addUploadDateRange.addEventListener('click', () => addDateRangeRow(els.uploadDateRanges));
addDateRangeRow(els.uploadDateRanges);
els.recheckOpened.addEventListener('click', recheckOpenedRows);
els.toggleTransport.addEventListener('click', toggleTransport);
els.instanceAll.addEventListener('click', () => setAllOptions(els.instanceOptions, state.excludedInstances, true));
els.instanceNone.addEventListener('click', () => setAllOptions(els.instanceOptions, state.excludedInstances, false));
document.addEventListener('click', (e) => {
  for (const menu of [els.instanceFilter, els.yearFilter]) {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  }
});
els.instanceSortHeader.addEventListener('click', () => {
  // sans tri -> A→Z -> Z→A -> sans tri
  state.instanceSort = { '': 'asc', asc: 'desc', desc: '' }[state.instanceSort];
  render();
});
// Un clic sur un en-tête inactif le rend tri principal ; sur l'en-tête actif, inverse le sens.
els.sortHeader.addEventListener('click', () => {
  if (state.primarySort === 'count') els.sortOrder.value = els.sortOrder.value === 'asc' ? 'desc' : 'asc';
  state.primarySort = 'count';
  render();
});
els.createdSortHeader.addEventListener('click', () => {
  if (state.primarySort === 'created') state.createdSort = state.createdSort === 'asc' ? 'desc' : 'asc';
  state.primarySort = 'created';
  render();
});
