export const acquireLockScript = `
local ok = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
return ok and 1 or 0
`;

export const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

export const renewLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

export const fixedWindowScript = `
local ttl = redis.call('PTTL', KEYS[1])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if ttl < 1 then count = 0; ttl = tonumber(ARGV[2]) end
if count + tonumber(ARGV[1]) > tonumber(ARGV[3]) then
  return {0, math.max(1, math.ceil(ttl / 1000))}
end
if count == 0 then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
else redis.call('INCRBY', KEYS[1], ARGV[1]); redis.call('PEXPIRE', KEYS[1], ttl) end
return {1, 0}
`;

export const acquireLeaseScript = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) - now) / 1000))}
end
redis.call('ZADD', KEYS[1], expiry, ARGV[4])
redis.call('PEXPIRE', KEYS[1], math.max(1, expiry - now))
return {1, expiry}
`;

export const releaseLeaseScript = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export const issuePermitScript = `
for i = 1, #KEYS do redis.call('SET', KEYS[i], ARGV[i], 'PX', ARGV[#KEYS + i]) end
return 1
`;

export const consumeCrossDetailScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0} end
local record = cjson.decode(raw)
if record.expiresAt <= tonumber(ARGV[1]) or record.nonce ~= ARGV[2] or record.requesterHmac ~= ARGV[3]
  or record.targetHmac ~= ARGV[4] or record.revisionHmac ~= ARGV[5]
  or record.rowHmac ~= ARGV[6] or record.policyVersion ~= tonumber(ARGV[7]) then return {0} end
local windowTtl = redis.call('PTTL', KEYS[3])
local count = tonumber(redis.call('GET', KEYS[3]) or '0')
if windowTtl < 1 then count = 0; windowTtl = tonumber(ARGV[9]) end
if count + 1 > tonumber(ARGV[8]) then return {2, math.max(1, math.ceil(windowTtl / 1000))} end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[10]) then return {3, 1} end
if count == 0 then redis.call('SET', KEYS[3], '1', 'PX', ARGV[9]) else redis.call('INCR', KEYS[3]); redis.call('PEXPIRE', KEYS[3], windowTtl) end
redis.call('DEL', KEYS[1])
redis.call('ZADD', KEYS[2], ARGV[11], ARGV[12])
redis.call('PEXPIRE', KEYS[2], math.max(1, tonumber(ARGV[11]) - tonumber(ARGV[1])))
return {1, tonumber(ARGV[11]), record.envelope}
`;

export const captchaTerminalScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.status ~= 'pending' or tonumber(state.expiresAt) <= tonumber(ARGV[2]) then return 0 end
state.status = ARGV[1]
state.answer = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(state), 'KEEPTTL')
redis.call('LPUSH', KEYS[2], ARGV[1])
local ttl = math.max(1, tonumber(redis.call('PTTL', KEYS[1])))
redis.call('PEXPIRE', KEYS[2], ttl)
if ARGV[1] == 'cancelled' then redis.call('DEL', KEYS[1]) end
return 1
`;
