import http from 'k6/http';

// Issues one JWT per user via POST /api/v1/auth/token, batched so 500 tokens
// don't serialize one request at a time in setup().
export function getTokens(baseUrl, count) {
  const requests = [];
  for (let i = 1; i <= count; i++) {
    requests.push([
      'POST',
      `${baseUrl}/api/v1/auth/token`,
      JSON.stringify({ userId: `user-${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    ]);
  }

  const responses = http.batch(requests);

  return responses.map((res, i) => ({
    userId: `user-${i + 1}`,
    token: res.json('accessToken'),
  }));
}
