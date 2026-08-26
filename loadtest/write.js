import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { getTokens } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'p-1001';
const USER_COUNT = 500;

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
      maxDuration: '1m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    orders_unexpected: ['rate<0.01'],
  },
};

export function setup() {
  return { tokens: getTokens(BASE_URL, USER_COUNT) };
}

// 409 covers two expected outcomes (duplicate claim, sold out) that k6 must
// not count as request failures — only a genuinely unexpected status is.
function fireOrder(token) {
  const res = http.request(
    'POST',
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({ productId: PRODUCT_ID }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      responseCallback: http.expectedStatuses(202, 409),
    },
  );

  // r.json() throws on a bodyless response (timeout, connection reset) —
  // treat that as unexpected rather than crashing the VU iteration.
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

export default function (data) {
  const entry = data.tokens[(__VU - 1) % data.tokens.length];

  fireOrder(entry.token);

  // Every 10th VU double/triple-fires with the same token, simulating a
  // real user's double-tap — this is what the SADD-based dedup must reject.
  if (__VU % 10 === 0) {
    const extraFires = 1 + Math.floor(Math.random() * 2); // 1-2 extra => 2-3 total
    for (let i = 0; i < extraFires; i++) {
      fireOrder(entry.token);
    }
  }
}
