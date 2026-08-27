import http from 'k6/http';

// Per-request HTTP timeout for the token batch. k6's default is 60s, which is
// also the default setupTimeout — one slow auth call could otherwise hang the
// whole run's setup(). Override with -e REQ_TIMEOUT=... (passed in by the caller).
const AUTH_TIMEOUT = __ENV.REQ_TIMEOUT || '10s';

// Issues one JWT per user via POST /api/v1/auth/token, batched so 500 tokens
// don't serialize one request at a time in setup().
//
// Spec 2.1 pins this endpoint to "Response (200 OK)". Assert it strictly here
// so a regression to Nest's default 201 fails setup loudly instead of handing
// out `Bearer undefined` tokens that only surface as 401s mid-run.
export function getTokens(baseUrl, count, timeout = AUTH_TIMEOUT) {
  const params = { headers: { 'Content-Type': 'application/json' }, timeout };
  const requests = [];
  for (let i = 1; i <= count; i++) {
    requests.push(['POST', `${baseUrl}/api/v1/auth/token`, JSON.stringify({ userId: `user-${i}` }), params]);
  }

  const responses = http.batch(requests);

  return responses.map((res, i) => {
    const userId = `user-${i + 1}`;
    if (res.status !== 200) {
      throw new Error(`auth/token for ${userId}: expected 200, got ${res.status} (body: ${res.body})`);
    }
    let token;
    try {
      token = res.json('accessToken');
    } catch (e) {
      throw new Error(`auth/token for ${userId}: response body is not JSON (${res.body})`);
    }
    if (!token) {
      throw new Error(`auth/token for ${userId}: 200 OK but no accessToken in body`);
    }
    return { userId, token };
  });
}
