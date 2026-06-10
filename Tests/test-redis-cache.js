const { Pool } = require('pg');
const { Redis } = require('ioredis');

const email = `redis-cache-${Date.now()}@example.com`;
const password = 'supersecretpassword123';
const baseUrl = 'http://localhost:3001';
const pool = new Pool({ connectionString: 'postgres://saga_admin:supersecretpassword@localhost:5433/seat_reservation_system' });
const redis = new Redis('redis://localhost:6379');

async function runTest() {
  console.log(`[1] Registering and authenticating test target: ${email}...`);
  await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const { accessToken } = await loginRes.json();

  // Decode JWT payload locally
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
  const userId = payload.userId;
  const cacheKey = `user:${userId}:ver`;

  console.log('\n[2] Checking instant cache warm-up step upon user login...');
  const activeCachedVer = await redis.get(cacheKey);
  console.log(` -> Redis Version Key [${cacheKey}] value: ${activeCachedVer} (Expected: 0)`);

  if (activeCachedVer === null) throw new Error('FAIL: Redis version string was not warmed up at login.');

  console.log('\n[3] Querying verification endpoint to simulate cluster lookups...');
  const verifyRes = await fetch(`${baseUrl}/verify`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!verifyRes.ok) throw new Error('Verification endpoint rejected active token.');
  console.log('✅ Lookaside token confirmation succeeded.');

  console.log('\n[4] Evicting the key manually from Redis to simulate a pure cache-miss flow...');
  await redis.del(cacheKey);

  console.log('[5] Re-running verification to assert fallback to SQL DB and repopulation...');
  const verifyMissRes = await fetch(`${baseUrl}/verify`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!verifyMissRes.ok) throw new Error('Verification failed during fallback sequence.');

  const repopulatedVer = await redis.get(cacheKey);
  console.log(` -> Redis Version Key after lookaside repopulation: ${repopulatedVer}`);
  if (repopulatedVer === null) throw new Error('FAIL: Lookaside helper failed to repair cache block on read-miss.');

  console.log('\n🚀 ALL TESTS PASSED: Redis cluster cache-aside lookups are perfectly operational!');
  pool.end();
  redis.quit();
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
