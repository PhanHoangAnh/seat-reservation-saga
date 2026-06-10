const { Pool } = require('pg');

const email = `version-${Date.now()}@example.com`;
const password = 'supersecretpassword123';
const baseUrl = 'http://localhost:3001';
const pool = new Pool({ connectionString: 'postgres://saga_admin:supersecretpassword@localhost:5433/seat_reservation_system' });

async function runTest() {
  console.log(`[1] Registering user: ${email}...`);
  const regRes = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!regRes.ok) throw new Error('Registration failed');

  console.log(`[2] Logging in...`);
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!loginRes.ok) throw new Error('Login failed');
  
  const { accessToken } = await loginRes.json();
  const loginCookies = loginRes.headers.getSetCookie();
  const refreshTokenCookie = loginCookies.find(c => c.startsWith('refreshToken='));
  const refreshToken = refreshTokenCookie.split(';')[0].split('=')[1];

  // Decode JWT payload locally without external libraries
  const payloadBase64 = accessToken.split('.')[1];
  const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
  console.log(`✅ Access Token payload successfully embeds 'ver' constraint: ${payload.ver !== undefined} (Value: ${payload.ver})`);

  // Verify initial DB version
  const dbResBefore = await pool.query('SELECT token_version FROM users WHERE email = $1', [email]);
  const verBefore = dbResBefore.rows[0].token_version;
  console.log(` -> Database token_version prior to logout: ${verBefore}`);

  console.log(`\n[3] Executing /logout endpoint...`);
  const logoutRes = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    headers: { 'Cookie': `refreshToken=${refreshToken}` }
  });
  if (!logoutRes.ok) throw new Error('Logout failed');

  // Verify incremented DB version
  const dbResAfter = await pool.query('SELECT token_version FROM users WHERE email = $1', [email]);
  const verAfter = dbResAfter.rows[0].token_version;
  console.log(` -> Database token_version after logout: ${verAfter}`);

  if (verAfter === verBefore + 1) {
    console.log('\n🚀 ALL TESTS PASSED: token_version safely tracks and increments on session revocation.');
  } else {
    throw new Error(`FAIL: Version mismatch! Expected ${verBefore + 1} but found ${verAfter}`);
  }
  
  await pool.end();
}

runTest().catch(async err => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
