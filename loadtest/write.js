import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { getTokens } from './lib/auth.js';

// ---- Tunables (all env-overridable) ----------------------------------------
const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const USER_COUNT = Number(__ENV.USER_COUNT || 500); // concurrent VUs, 1 unique user each
const MAX_DURATION = __ENV.MAX_DURATION || '10m'; // safety ceiling only; 500 single fires finish in ~1-3s
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '10s'; // per-request HTTP timeout (k6 default is 60s)
// The write scenario is a single burst (1 iteration/VU), so it finishes in a
// few seconds — MAX_DURATION is just the safety ceiling.
// --------------------------------------------------------------------------

const ordersAccepted = new Counter('orders_accepted');
const ordersDuplicate = new Counter('orders_duplicate');
const ordersSoldout = new Counter('orders_soldout');
const ordersUnexpected = new Rate('orders_unexpected');

export const options = {
  scenarios: {
    write: {
      executor: 'per-vu-iterations',
      vus: USER_COUNT,
      iterations: 1,
      maxDuration: MAX_DURATION,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    orders_unexpected: ['rate<0.01'],
  },
  // 500 token requests fire concurrently in setup(); cap the wait so a stuck
  // stack fails fast instead of hanging on k6's 60s default.
  setupTimeout: '30s',
};

export function setup() {
  return { tokens: getTokens(BASE_URL, USER_COUNT, REQ_TIMEOUT) };
}

const ORDER_PARAMS = {
  headers: { 'Content-Type': 'application/json' },
  timeout: REQ_TIMEOUT,
  // 409 covers two expected outcomes (duplicate claim, sold out) that k6 must
  // not count as request failures — only a genuinely unexpected status is.
  responseCallback: http.expectedStatuses(202, 409),
};

// Tallies one order response into the custom counters. r.json() throws on a
// bodyless response (timeout, connection reset) — treat that as unexpected
// rather than crashing the VU iteration.
function countRes(res) {
  let body = null;
  try {
    body = res.json();
  } catch (e) {
    // leave body null
  }
  const isUnexpected = res.status !== 202 && res.status !== 409;
  ordersUnexpected.add(isUnexpected);

  if (res.status === 202) {
    ordersAccepted.add(1);
  } else if (res.status === 409 && body && body.message === 'Product sold out') {
    ordersSoldout.add(1);
  } else if (res.status === 409) {
    ordersDuplicate.add(1);
  }

  check(res, {
    'status is 202 or 409': (r) => r.status === 202 || r.status === 409,
  });
}

function orderBody() {
  return JSON.stringify({ productId: PRODUCT_ID });
}

function fireOrder(token) {
  const res = http.request('POST', `${BASE_URL}/api/v1/orders`, orderBody(), {
    ...ORDER_PARAMS,
    headers: { ...ORDER_PARAMS.headers, Authorization: `Bearer ${token}` },
  });
  countRes(res);
}

// Spec: "จำลองให้ User บางคนยิง Request เบิ้ลมา 2-3 ครั้งพร้อมๆ กัน" — the
// duplicate requests must hit concurrently, not one-after-another, or the
// SADD atomic lock is never actually raced. http.batch fires them in parallel
// from the same VU with the same token.
function fireOrderBurst(token, n) {
  const req = {
    method: 'POST',
    url: `${BASE_URL}/api/v1/orders`,
    body: orderBody(),
    params: {
      ...ORDER_PARAMS,
      headers: { ...ORDER_PARAMS.headers, Authorization: `Bearer ${token}` },
    },
  };
  const responses = http.batch(Array.from({ length: n }, () => req));
  responses.forEach(countRes);
}

export default function (data) {
  const entry = data.tokens[(__VU - 1) % data.tokens.length];

  // Every 10th VU is a "double-tapper": 2-3 concurrent identical requests.
  // Everyone else fires exactly once.
  if (__VU % 10 === 0) {
    const total = 2 + Math.floor(Math.random() * 2); // 2 or 3 concurrent
    fireOrderBurst(entry.token, total);
  } else {
    fireOrder(entry.token);
  }
}

// Report requirements #1 (Cache) and #2 (Queue): dump the API counters and
// point at the manual sources so the run is self-documenting.
export function teardown() {
  sleep(2); // MetricsService flushes in-memory counters to Redis once a second
  const res = http.get(`${BASE_URL}/api/v1/_metrics`, { timeout: REQ_TIMEOUT });
  let m = {};
  try {
    m = res.json('metrics') || {};
  } catch (e) {
    console.log('teardown: could not read /api/v1/_metrics');
    return;
  }

  console.log('--- Order counters (GET /api/v1/_metrics) ---');
  console.log(`orders_accepted  : ${m.orders_accepted || 0}`);
  console.log(`orders_duplicate : ${m.orders_duplicate || 0}`);
  console.log(`orders_soldout   : ${m.orders_soldout || 0}`);
  console.log('');
  console.log('Queue status (manual): Bull-Board at http://localhost:3001/admin/queues');
  console.log('Data integrity (manual):');
  console.log(`  SELECT remaining_stock FROM products WHERE product_id = '${PRODUCT_ID}';   -- expect 0`);
  console.log(
    `  SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = '${PRODUCT_ID}';  -- expect 50 / 50`,
  );
}
