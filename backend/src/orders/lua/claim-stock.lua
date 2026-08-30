-- KEYS[1] = cache:claim:{productId}   ARGV[1] = userId
-- KEYS[2] = cache:stock:{productId}
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return -1 -- duplicate
end

-- DECR first (single call): on underflow put it back and release the claim.
-- Cheaper than GET+check+DECR; DECR on a missing key treats it as 0 -> -1.
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2 -- sold out
end
return left