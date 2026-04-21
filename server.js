// server.js — Riga Bus GTFS-RT Proxy
// Fetches live data from Rīgas Satiksme and serves it with CORS headers

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const FEEDS = {
  vehicle_positions: 'https://saraksti.rigassatiksme.lv/vehicle_positions.pb',
  trip_updates:      'https://saraksti.rigassatiksme.lv/trip_updates.pb',
  gtfs_realtime:     'https://saraksti.rigassatiksme.lv/gtfs_realtime.pb',
};

// Simple in-memory cache so we don't hammer RS on every request
const cache = {};
const CACHE_TTL = 15000; // 15 seconds

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

async function getWithCache(key, url) {
  const now = Date.now();
  if (cache[key] && (now - cache[key].ts) < CACHE_TTL) {
    return cache[key].data;
  }
  const { data } = await fetchUpstream(url);
  cache[key] = { ts: now, data };
  return data;
}

// Minimal protobuf decoder for GTFS-RT
// Decodes vehicle positions and trip updates without any npm dependencies
function decodeVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos++];
    result |= (b & 0x7F) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value: result, pos };
}

function decodeString(buf, pos, len) {
  return buf.slice(pos, pos + len).toString('utf8');
}

function parseGTFSRT(buf) {
  const entities = [];
  let pos = 2; // skip header bytes

  try {
    while (pos < buf.length) {
      if (buf[pos] === undefined) break;
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) {
        // length-delimited
        const lenResult = decodeVarint(buf, pos);
        pos = lenResult.pos;
        const len = lenResult.value;
        const entityBuf = buf.slice(pos, pos + len);
        pos += len;

        if (fieldNum === 2) {
          // FeedEntity
          entities.push(parseEntity(entityBuf));
        }
      } else if (wireType === 0) {
        const v = decodeVarint(buf, pos);
        pos = v.pos;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 1) {
        pos += 8;
      } else {
        break;
      }
    }
  } catch(e) {}

  return entities.filter(Boolean);
}

function parseEntity(buf) {
  let pos = 0;
  const entity = {};

  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) {
        const lenResult = decodeVarint(buf, pos);
        pos = lenResult.pos;
        const len = lenResult.value;
        const sub = buf.slice(pos, pos + len);
        pos += len;

        if (fieldNum === 1) entity.id = sub.toString('utf8');
        else if (fieldNum === 2) entity.vehicle = parseVehiclePos(sub);
        else if (fieldNum === 3) entity.trip_update = parseTripUpdate(sub);
      } else if (wireType === 0) {
        const v = decodeVarint(buf, pos);
        pos = v.pos;
        if (fieldNum === 1) entity.id = v.value;
      } else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}

  return Object.keys(entity).length > 1 ? entity : null;
}

function parseVehiclePos(buf) {
  let pos = 0;
  const vp = {};

  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) {
        const lenResult = decodeVarint(buf, pos);
        pos = lenResult.pos;
        const len = lenResult.value;
        const sub = buf.slice(pos, pos + len);
        pos += len;

        if (fieldNum === 1) vp.trip = parseTripDesc(sub);
        else if (fieldNum === 2) vp.position = parsePosition(sub);
        else if (fieldNum === 3) vp.vehicle = parseVehicleDesc(sub);
      } else if (wireType === 0) {
        const v = decodeVarint(buf, pos);
        pos = v.pos;
        if (fieldNum === 4) vp.current_stop_sequence = v.value;
        else if (fieldNum === 5) vp.current_status = v.value;
        else if (fieldNum === 6) vp.timestamp = v.value;
        else if (fieldNum === 7) vp.congestion_level = v.value;
        else if (fieldNum === 9) vp.occupancy_status = v.value;
      } else if (wireType === 5) {
        pos += 4;
      } else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}

  return vp;
}

function parsePosition(buf) {
  let pos = 0;
  const p = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 5) {
        const view = new DataView(buf.buffer, buf.byteOffset + pos, 4);
        const val = view.getFloat32(0, true);
        pos += 4;
        if (fieldNum === 1) p.lat = +val.toFixed(6);
        else if (fieldNum === 2) p.lon = +val.toFixed(6);
        else if (fieldNum === 3) p.bearing = +val.toFixed(1);
        else if (fieldNum === 4) p.odometer = val;
        else if (fieldNum === 5) p.speed = +val.toFixed(2);
      } else if (wireType === 1) { pos += 8; }
      else if (wireType === 0) { const v = decodeVarint(buf, pos); pos = v.pos; }
      else if (wireType === 2) { const l = decodeVarint(buf, pos); pos = l.pos + l.value; }
      else break;
    }
  } catch(e) {}
  return p;
}

function parseTripDesc(buf) {
  let pos = 0;
  const t = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 2) {
        const l = decodeVarint(buf, pos); pos = l.pos;
        const s = buf.slice(pos, pos + l.value); pos += l.value;
        if (fieldNum === 1) t.trip_id = s.toString('utf8');
        else if (fieldNum === 3) t.route_id = s.toString('utf8');
      } else if (wireType === 0) { const v = decodeVarint(buf, pos); pos = v.pos; }
      else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}
  return t;
}

function parseVehicleDesc(buf) {
  let pos = 0;
  const v = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 2) {
        const l = decodeVarint(buf, pos); pos = l.pos;
        const s = buf.slice(pos, pos + l.value); pos += l.value;
        if (fieldNum === 1) v.id = s.toString('utf8');
        else if (fieldNum === 2) v.label = s.toString('utf8');
      } else if (wireType === 0) { const v2 = decodeVarint(buf, pos); pos = v2.pos; }
      else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}
  return v;
}

function parseTripUpdate(buf) {
  let pos = 0;
  const tu = { stop_time_updates: [] };
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 2) {
        const l = decodeVarint(buf, pos); pos = l.pos;
        const sub = buf.slice(pos, pos + l.value); pos += l.value;
        if (fieldNum === 1) tu.trip = parseTripDesc(sub);
        else if (fieldNum === 3) tu.vehicle = parseVehicleDesc(sub);
        else if (fieldNum === 2) tu.stop_time_updates.push(parseSTU(sub));
      } else if (wireType === 0) { const v = decodeVarint(buf, pos); pos = v.pos; }
      else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}
  return tu;
}

function parseSTU(buf) {
  let pos = 0;
  const s = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 2) {
        const l = decodeVarint(buf, pos); pos = l.pos;
        const sub = buf.slice(pos, pos + l.value); pos += l.value;
        if (fieldNum === 2) s.arrival = parseTimeEvent(sub);
        else if (fieldNum === 3) s.departure = parseTimeEvent(sub);
        else if (fieldNum === 4) s.stop_id = sub.toString('utf8');
      } else if (wireType === 0) {
        const v = decodeVarint(buf, pos); pos = v.pos;
        if (fieldNum === 1) s.stop_sequence = v.value;
      } else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else break;
    }
  } catch(e) {}
  return s;
}

function parseTimeEvent(buf) {
  let pos = 0;
  const e = {};
  try {
    while (pos < buf.length) {
      const tag = buf[pos++];
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 0) {
        const v = decodeVarint(buf, pos); pos = v.pos;
        if (fieldNum === 1) e.delay = v.value;
        else if (fieldNum === 2) e.time = v.value;
      } else if (wireType === 5) { pos += 4; }
      else if (wireType === 1) { pos += 8; }
      else if (wireType === 2) { const l = decodeVarint(buf, pos); pos = l.pos + l.value; }
      else break;
    }
  } catch(e2) {}
  return e;
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
    if (path === '/vehicles') {
      const buf = await getWithCache('vp', FEEDS.vehicle_positions);
      const entities = parseGTFSRT(buf);
      const vehicles = entities
        .filter(e => e && e.vehicle && e.vehicle.position)
        .map(e => ({
          id:        e.id,
          vehicleId: e.vehicle.vehicle?.id,
          label:     e.vehicle.vehicle?.label,
          tripId:    e.vehicle.trip?.trip_id,
          routeId:   e.vehicle.trip?.route_id,
          lat:       e.vehicle.position?.lat,
          lon:       e.vehicle.position?.lon,
          bearing:   e.vehicle.position?.bearing,
          speed:     e.vehicle.position?.speed,
          status:    e.vehicle.current_status,
          occupancy: e.vehicle.occupancy_status,
          timestamp: e.vehicle.timestamp,
        }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, count: vehicles.length, vehicles, ts: Date.now() }));

    } else if (path === '/trips') {
      const buf = await getWithCache('tu', FEEDS.trip_updates);
      const entities = parseGTFSRT(buf);
      const trips = entities
        .filter(e => e && e.trip_update)
        .map(e => ({
          tripId:  e.trip_update.trip?.trip_id,
          routeId: e.trip_update.trip?.route_id,
          vehicle: e.trip_update.vehicle?.id,
          updates: (e.trip_update.stop_time_updates || []).slice(0, 5).map(s => ({
            stopId:    s.stop_id,
            seq:       s.stop_sequence,
            delay:     s.arrival?.delay || s.departure?.delay || 0,
            arrTime:   s.arrival?.time,
            depTime:   s.departure?.time,
          }))
        }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, count: trips.length, trips, ts: Date.now() }));

    } else if (path === '/health') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));

    } else {
      res.writeHead(404, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, error: 'Not found', routes: ['/vehicles', '/trips', '/health'] }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => console.log(`Riga Bus proxy running on port ${PORT}`));
