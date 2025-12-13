const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const CACHE_DIR = path.join(__dirname, '.cache');
const ZIP_PATH = path.join(CACHE_DIR, 'cta_gtfs.zip');
const META_PATH = path.join(CACHE_DIR, 'cta_gtfs.meta.json');

const ZIP_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613; // miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readMeta() {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  try {
    ensureCacheDir();
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

async function downloadZipIfNeeded(fetchFn) {
  ensureCacheDir();
  const meta = readMeta();
  const fresh = meta?.downloadedAt && Date.now() - meta.downloadedAt < ZIP_TTL_MS;
  if (fresh && fs.existsSync(ZIP_PATH)) return { zipPath: ZIP_PATH, updatedAt: meta.updatedAt || null };

  const res = await fetchFn(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ZIP_PATH, buf);
  const updatedAt = new Date().toISOString();
  writeMeta({ downloadedAt: Date.now(), updatedAt, url: GTFS_URL, bytes: buf.length });
  return { zipPath: ZIP_PATH, updatedAt };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function readZipEntryToLines(zipPath, filename) {
  const directory = await unzipper.Open.file(zipPath);
  const file = directory.files.find((f) => f.path === filename);
  if (!file) throw new Error(`GTFS missing ${filename}`);
  const buf = await file.buffer();
  const text = buf.toString('utf-8');
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

async function buildGtfsIndex(fetchFn) {
  const { zipPath, updatedAt } = await downloadZipIfNeeded(fetchFn);

  const routesLines = await readZipEntryToLines(zipPath, 'routes.txt');
  const tripsLines = await readZipEntryToLines(zipPath, 'trips.txt');
  const stopsLines = await readZipEntryToLines(zipPath, 'stops.txt');
  const stopTimesLines = await readZipEntryToLines(zipPath, 'stop_times.txt');

  const [routesHeader, ...routesRows] = routesLines;
  const routesCols = parseCsvLine(routesHeader);
  const routeIdx = Object.fromEntries(routesCols.map((c, i) => [c, i]));
  const routeById = new Map();
  for (const line of routesRows) {
    const row = parseCsvLine(line);
    const route_id = row[routeIdx.route_id];
    if (!route_id) continue;
    routeById.set(route_id, {
      route_id,
      short_name: row[routeIdx.route_short_name] || '',
      long_name: row[routeIdx.route_long_name] || '',
      route_type: Number(row[routeIdx.route_type])
    });
  }

  const [tripsHeader, ...tripsRows] = tripsLines;
  const tripsCols = parseCsvLine(tripsHeader);
  const tripIdx = Object.fromEntries(tripsCols.map((c, i) => [c, i]));
  const tripToRoute = new Map();
  for (const line of tripsRows) {
    const row = parseCsvLine(line);
    const trip_id = row[tripIdx.trip_id];
    const route_id = row[tripIdx.route_id];
    if (trip_id && route_id) tripToRoute.set(trip_id, route_id);
  }

  const [stopsHeader, ...stopsRows] = stopsLines;
  const stopsCols = parseCsvLine(stopsHeader);
  const stopIdx = Object.fromEntries(stopsCols.map((c, i) => [c, i]));
  const stopById = new Map();
  for (const line of stopsRows) {
    const row = parseCsvLine(line);
    const stop_id = row[stopIdx.stop_id];
    const stop_name = row[stopIdx.stop_name];
    const stop_lat = Number(row[stopIdx.stop_lat]);
    const stop_lon = Number(row[stopIdx.stop_lon]);
    const location_type = Number(row[stopIdx.location_type] || 0);
    if (!stop_id || !stop_name || !Number.isFinite(stop_lat) || !Number.isFinite(stop_lon)) continue;
    // location_type 1 = station, 0 = stop/platform; keep both for now
    stopById.set(stop_id, { stop_id, stop_name, lat: stop_lat, lng: stop_lon, location_type });
  }

  const stopToRoutes = new Map(); // stop_id -> Set(route_id)
  const [stHeader, ...stRows] = stopTimesLines;
  const stCols = parseCsvLine(stHeader);
  const stIdx = Object.fromEntries(stCols.map((c, i) => [c, i]));
  for (const line of stRows) {
    const row = parseCsvLine(line);
    const trip_id = row[stIdx.trip_id];
    const stop_id = row[stIdx.stop_id];
    if (!trip_id || !stop_id) continue;
    const route_id = tripToRoute.get(trip_id);
    if (!route_id) continue;
    let set = stopToRoutes.get(stop_id);
    if (!set) {
      set = new Set();
      stopToRoutes.set(stop_id, set);
    }
    if (set.size < 12) set.add(route_id);
  }

  return {
    updatedAt,
    stopById,
    routeById,
    stopToRoutes
  };
}

let inFlight = null;
let cache = null;
let cacheLoadedAt = 0;

async function getIndex(fetchFn) {
  const fresh = cache && Date.now() - cacheLoadedAt < ZIP_TTL_MS;
  if (fresh) return cache;
  if (inFlight) return inFlight;
  inFlight = buildGtfsIndex(fetchFn)
    .then((idx) => {
      cache = idx;
      cacheLoadedAt = Date.now();
      return cache;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function classifyMode(routeType) {
  // GTFS: 3=Bus, 1=Subway/Metro, 2=Rail. CTA uses 1 for L trains, 3 for buses.
  if (routeType === 3) return 'bus';
  if (routeType === 1) return 'train';
  if (routeType === 2) return 'rail';
  return 'other';
}

async function findNearby({ fetchFn, lat, lng, radiusMeters = 1200, limit = 12 }) {
  const idx = await getIndex(fetchFn);
  const radiusMi = Math.max(0.1, Number(radiusMeters) / 1609.344);
  const out = [];
  for (const stop of idx.stopById.values()) {
    const dMi = haversineMiles(lat, lng, stop.lat, stop.lng);
    if (dMi > radiusMi) continue;
    const routeIds = Array.from(idx.stopToRoutes.get(stop.stop_id) || []);
    const routes = routeIds
      .map((id) => idx.routeById.get(id))
      .filter(Boolean)
      .map((r) => ({
        id: r.route_id,
        shortName: r.short_name || r.long_name || 'Route',
        longName: r.long_name || r.short_name || '',
        type: classifyMode(r.route_type)
      }));
    const modes = Array.from(new Set(routes.map((r) => r.type))).filter(Boolean);
    out.push({
      id: stop.stop_id,
      name: stop.stop_name,
      lat: stop.lat,
      lng: stop.lng,
      distanceMi: Number(dMi.toFixed(2)),
      modes,
      routes: routes.slice(0, 12)
    });
  }
  out.sort((a, b) => a.distanceMi - b.distanceMi);
  return { updatedAt: idx.updatedAt, stops: out.slice(0, Math.max(1, Math.min(50, Number(limit) || 12))) };
}

module.exports = {
  findNearby
};

