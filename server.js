// server.js — Riga Bus GTFS-RT Proxy v2
const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 3000;

const FEEDS = {
  vehicle_positions: 'https://saraksti.rigassatiksme.lv/vehicle_positions.pb',
  trip_updates:      'https://saraksti.rigassatiksme.lv/trip_updates.pb',
};

const cache = {};
const CACHE_TTL_PB  = 15000; // 15s for vehicle/trip feeds
const CACHE_TTL_DEP = 10000; // 10s for departures

function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getWithCache(key, url, ttl) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < ttl) return cache[key].data;
  const { data } = await fetchUpstream(url);
  cache[key] = { ts: now, data };
  return data;
}

// Parse departures2.php response
// Format: type,routeNum,direction,secondsUntil,vehicleId,destination
function parseDepartures(text) {
  const lines = text.trim().split('\n').slice(1); // skip header line
  return lines.map(line => {
    const parts = line.trim().split(',');
    if (parts.length < 6) return null;
    const secs = parseInt(parts[3]);
    const mins = Math.floor(secs / 60);
    const now = Date.now();
    const arrivalTime = new Date(now + secs * 1000);
    const hh = String(arrivalTime.getHours()).padStart(2,'0');
    const mm = String(arrivalTime.getMinutes()).padStart(2,'0');
    return {
      type:        parts[0].trim(),
      route:       parts[1].trim(),
      direction:   parts[2].trim(),
      seconds:     secs,
      minutes:     mins,
      arrivalTime: `${hh}:${mm}`,
      vehicleId:   parts[4].trim(),
      destination: parts[5].trim(),
    };
  }).filter(Boolean);
}

// Minimal protobuf decoder (same as before)
function decodeVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result |= (b & 0x7F) << shift; shift += 7; } while (b & 0x80);
  return { value: result, pos };
}
function parseGTFSRT(buf) {
  const entities = []; let pos = 2;
  try {
    while (pos < buf.length) {
      if (buf[pos] === undefined) break;
      const tag = buf[pos++]; const fieldNum = tag >> 3; const wireType = tag & 0x7;
      if (wireType === 2) {
        const lr = decodeVarint(buf, pos); pos = lr.pos;
        const sub = buf.slice(pos, pos + lr.value); pos += lr.value;
        if (fieldNum === 2) entities.push(parseEntity(sub));
      } else if (wireType === 0) { const v = decodeVarint(buf, pos); pos = v.pos; }
      else if (wireType === 5) { pos += 4; } else if (wireType === 1) { pos += 8; } else break;
    }
  } catch(e) {}
  return entities.filter(Boolean);
}
function parseEntity(buf) {
  let pos = 0; const e = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++]; const f = tag >> 3; const w = tag & 0x7;
      if (w === 2) {
        const lr = decodeVarint(buf, pos); pos = lr.pos;
        const sub = buf.slice(pos, pos + lr.value); pos += lr.value;
        if (f === 1) e.id = sub.toString('utf8');
        else if (f === 2) e.vehicle = parseVP(sub);
        else if (f === 3) e.trip_update = parseTU(sub);
      } else if (w === 0) { const v = decodeVarint(buf, pos); pos = v.pos; if(f===1)e.id=v.value; }
      else if (w === 5) { pos += 4; } else if (w === 1) { pos += 8; } else break;
    }
  } catch(e2) {}
  return Object.keys(e).length > 1 ? e : null;
}
function readFields(buf, handlers) {
  let pos = 0;
  try {
    while (pos < buf.length) {
      const tag = buf[pos++]; const f = tag >> 3; const w = tag & 0x7;
      if (w === 2) {
        const lr = decodeVarint(buf, pos); pos = lr.pos;
        const sub = buf.slice(pos, pos + lr.value); pos += lr.value;
        if (handlers[`l${f}`]) handlers[`l${f}`](sub);
      } else if (w === 0) {
        const v = decodeVarint(buf, pos); pos = v.pos;
        if (handlers[`v${f}`]) handlers[`v${f}`](v.value);
      } else if (w === 5) {
        const view = new DataView(buf.buffer, buf.byteOffset + pos, 4);
        const val = view.getFloat32(0, true); pos += 4;
        if (handlers[`f${f}`]) handlers[`f${f}`](val);
      } else if (w === 1) { pos += 8; } else break;
    }
  } catch(e) {}
}
function parseVP(buf) {
  const vp = {};
  readFields(buf, {
    l1: s => { vp.trip = {}; readFields(s, { l1: b => vp.trip.trip_id = b.toString('utf8'), l3: b => vp.trip.route_id = b.toString('utf8') }); },
    l2: s => { vp.position = {}; readFields(s, { f1: v => vp.position.lat = +v.toFixed(6), f2: v => vp.position.lon = +v.toFixed(6), f3: v => vp.position.bearing = +v.toFixed(1), f5: v => vp.position.speed = +v.toFixed(2) }); },
    l3: s => { vp.vehicle = {}; readFields(s, { l1: b => vp.vehicle.id = b.toString('utf8'), l2: b => vp.vehicle.label = b.toString('utf8') }); },
    v6: v => vp.timestamp = v,
    v9: v => vp.occupancy_status = v,
  });
  return vp;
}
function parseTU(buf) {
  const tu = { stop_time_updates: [] };
  readFields(buf, {
    l1: s => { tu.trip = {}; readFields(s, { l1: b => tu.trip.trip_id = b.toString('utf8'), l3: b => tu.trip.route_id = b.toString('utf8') }); },
    l3: s => { tu.vehicle = {}; readFields(s, { l1: b => tu.vehicle.id = b.toString('utf8') }); },
    l2: s => {
      const stu = {};
      readFields(s, {
        v1: v => stu.stop_sequence = v,
        l4: b => stu.stop_id = b.toString('utf8'),
        l2: b => { stu.arrival = {}; readFields(b, { v1: v => stu.arrival.delay = v, v2: v => stu.arrival.time = v }); },
        l3: b => { stu.departure = {}; readFields(b, { v1: v => stu.departure.delay = v, v2: v => stu.departure.time = v }); },
      });
      tu.stop_time_updates.push(stu);
    },
  });
  return tu;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ── /departures?stopid=XXXX ──────────────────────────────────────────────
    if (path === '/departures') {
      const stopId = url.searchParams.get('stopid');
      if (!stopId) { res.writeHead(400); res.end(JSON.stringify({ok:false,error:'stopid required'})); return; }
      const raw = await getWithCache(`dep_${stopId}`, `https://saraksti.rigassatiksme.lv/departures2.php?stopid=${stopId}`, CACHE_TTL_DEP);
      const text = raw.toString('utf8');
      const departures = parseDepartures(text);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, stopId, count: departures.length, departures, ts: Date.now() }));

    // ── /vehicles ────────────────────────────────────────────────────────────
    } else if (path === '/vehicles') {
      const buf = await getWithCache('vp', FEEDS.vehicle_positions, CACHE_TTL_PB);
      const entities = parseGTFSRT(buf);
      const vehicles = entities.filter(e => e?.vehicle?.position).map(e => ({
        id: e.id, vehicleId: e.vehicle.vehicle?.id, label: e.vehicle.vehicle?.label,
        tripId: e.vehicle.trip?.trip_id, routeId: e.vehicle.trip?.route_id,
        lat: e.vehicle.position?.lat, lon: e.vehicle.position?.lon,
        bearing: e.vehicle.position?.bearing, speed: e.vehicle.position?.speed,
        occupancy: e.vehicle.occupancy_status, timestamp: e.vehicle.timestamp,
      }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, count: vehicles.length, vehicles, ts: Date.now() }));

    // ── /trips ───────────────────────────────────────────────────────────────
    } else if (path === '/trips') {
      const buf = await getWithCache('tu', FEEDS.trip_updates, CACHE_TTL_PB);
      const entities = parseGTFSRT(buf);
      const trips = entities.filter(e => e?.trip_update).map(e => ({
        tripId: e.trip_update.trip?.trip_id, routeId: e.trip_update.trip?.route_id,
        vehicle: e.trip_update.vehicle?.id,
        updates: (e.trip_update.stop_time_updates || []).slice(0,5).map(s => ({
          stopId: s.stop_id, seq: s.stop_sequence,
          delay: s.arrival?.delay || s.departure?.delay || 0,
          arrTime: s.arrival?.time, depTime: s.departure?.time,
        }))
      }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, count: trips.length, trips, ts: Date.now() }));

    // ── /health ──────────────────────────────────────────────────────────────
    } else if (path === '/health') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));

    } else {
      res.writeHead(404, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'Not found', routes: ['/departures?stopid=XXXX', '/vehicles', '/trips', '/health'] }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => console.log(`Riga Bus proxy v2 on port ${PORT}`));
