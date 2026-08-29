-- KEYS[1] = cache:claim:{productId}   ARGV[1] = userId
-- KEYS[2] = cache:stock:{productId}
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return -1 -- duplicate
end

local stock = tonumber(redis.call('GET', KEYS[2]) or "0")
if stock <= 0 then
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2 -- sold out
end

local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2 -- sold out fallback
end
return left