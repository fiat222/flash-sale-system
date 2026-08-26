import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const LIMITS = [10, 20, 50];

export const options = {
  scenarios: {
    read: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 },
        { duration: '1m', target: 1000 },
        { duration: '15s', target: 0 },
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
  let page;
  let limit;

  // 5% of requests send garbage input to exercise the clamp-to-default path
  // documented in the architecture doc (page=-5, limit=abc must not 500).
  if (Math.random() < 0.05) {
    page = Math.random() < 0.5 ? -5 : 99999;
    limit = 'abc';
  } else {
    page = randInt(1, 3);
    limit = LIMITS[randInt(0, LIMITS.length - 1)];
  }

  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`);

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
