import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
// MIX=1 restores the old randomised page/limit + 5% garbage-input variant used
// for clamp-path robustness testing. Default is the exact spec request so the
// L1/L2/miss ratio in GET /api/v1/_metrics stays clean (one template key).
const MIX = __ENV.MIX === '1';
const LIMITS = [10, 20, 50];

// ---- Tunables (all env-overridable) ----------------------------------------
const TARGET = Number(__ENV.TARGET || 1000); // peak concurrent VUs
const RAMP = __ENV.RAMP || '10s'; // 0 -> TARGET
const HOLD = __ENV.HOLD || '35s'; // plateau at TARGET
const RAMPDOWN = __ENV.RAMPDOWN || '5s'; // TARGET -> 0
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '10s'; // per-request HTTP timeout (k6 default is 60s)
// Total run time = RAMP + HOLD + RAMPDOWN = ~50s. Long soak: -e HOLD=1m -e RAMP=30s
// --------------------------------------------------------------------------

const PARAMS = { timeout: REQ_TIMEOUT };

export const options = {
  scenarios: {
    read: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: TARGET },
        { duration: HOLD, target: TARGET },
        { duration: RAMPDOWN, target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// r.json() throws when the response has no body (timeout, connection reset) —
// checks must return false in that case, not crash the whole VU iteration.
function safeJson(r) {
  try {
    return r.json();
  } catch (e) {
    return null;
  }
}

export default function () {
  // Spec: GET /api/v1/products?page=1&limit=10, 1,000 concurrent users.
  let page = 1;
  let limit = 10;

  if (MIX) {
    // 5% of requests send garbage input to exercise the clamp-to-default path
    // documented in the architecture doc (page=-5, limit=abc must not 500).
    if (Math.random() < 0.05) {
      page = Math.random() < 0.5 ? -5 : 99999;
      limit = 'abc';
    } else {
      page = randInt(1, 3);
      limit = LIMITS[randInt(0, LIMITS.length - 1)];
    }
  }

  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, PARAMS);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'totalPages matches formula': (r) => {
      if (r.status !== 200) return false;
      const body = safeJson(r);
      return !!body && !!body.meta && body.meta.totalPages === Math.ceil(body.meta.total / body.meta.limit);
    },
    'data length <= limit': (r) => {
      if (r.status !== 200) return false;
      const body = safeJson(r);
      return !!body && Array.isArray(body.data) && body.data.length <= body.meta.limit;
    },
  });
}

// Report requirement #1 (Cache Performance): print the L1/L2/miss counters and
// the derived hit ratio straight from the API so the run is self-documenting.
export function teardown() {
  sleep(2); // MetricsService flushes in-memory counters to Redis once a second
  const res = http.get(`${BASE_URL}/api/v1/_metrics`, PARAMS);
  let m = {};
  try {
    m = res.json('metrics') || {};
  } catch (e) {
    console.log('teardown: could not read /api/v1/_metrics');
    return;
  }

  const hits = m.cache_hit || 0; // Redis template hit
  const miss = m.cache_miss || 0; // Postgres rebuild
  const total = hits + miss;
  const pct = (n) => (total ? ((n / total) * 100).toFixed(2) : '0.00');

  console.log('--- Cache Performance (GET /api/v1/_metrics) — Redis-only Cache-Aside ---');
  console.log(`lookups total : ${total}`);
  console.log(`cache_hit  (Redis)          : ${hits} (${pct(hits)}%)`);
  console.log(`cache_miss (Postgres build) : ${miss} (${pct(miss)}%)`);
  console.log(`HIT / MISS    : ${pct(hits)}% hit  /  ${pct(miss)}% miss   (${hits} hit / ${miss} miss)`);
}
