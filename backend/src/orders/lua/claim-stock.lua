-- KEYS[1] = cache:claim:{productId}   ARGV[1] = userId
-- KEYS[2] = cache:stock:{productId}
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return -1                                    -- duplicate purchase attempt
end
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])         -- return the claim to the user
  return -2                                    -- sold out
end
return left                                    -- success
