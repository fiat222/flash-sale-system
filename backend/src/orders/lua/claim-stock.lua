-- KEYS[1] = cache:claim:{productId}   ARGV[1] = userId
-- KEYS[2] = cache:stock:{productId}
-- Metric counters folded in here so the HTTP path spends one round trip per
-- request instead of two (claim + separate fire-and-forget INCR).
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  redis.call('INCR', 'cache:m:orders_duplicate')
  return -1 -- duplicate
end

-- DECR first (single call): on underflow put it back and release the claim.
-- Cheaper than GET+check+DECR; DECR on a missing key treats it as 0 -> -1.
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])
  redis.call('INCR', 'cache:m:orders_soldout')
  return -2 -- sold out
end
redis.call('INCR', 'cache:m:orders_accepted')
return left