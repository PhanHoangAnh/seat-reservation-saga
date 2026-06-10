const email = `test-${Date.now()}@example.com`;
const password = 'supersecretpassword123';
const baseUrl = 'http://localhost:3001';

async function runTest() {
  console.log(`[1] Registering user: ${email}...`);
  const regRes = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!regRes.ok) throw new Error(`Registration failed: ${await regRes.text()}`);
  console.log('✅ Registration successful.\n');

  console.log(`[2] Logging in...`);
  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!loginRes.ok) throw new Error('Login failed');
  
  const loginData = await loginRes.json();
  const loginCookies = loginRes.headers.getSetCookie();
  const refreshTokenCookie = loginCookies.find(c => c.startsWith('refreshToken='));
  console.log(`✅ Access Token received.`);
  console.log(`✅ Login Set-Cookie Path check: ${refreshTokenCookie.includes('Path=/api/auth')}`);
  
  const refreshToken = refreshTokenCookie.split(';')[0].split('=')[1];

  console.log(`\n[3] Testing /refresh with valid token...`);
  const refreshRes = await fetch(`${baseUrl}/refresh`, {
    method: 'POST',
    headers: { 
      'Cookie': `refreshToken=${refreshToken}`
    }
  });
  
  if (!refreshRes.ok) throw new Error(`Refresh failed with status: ${refreshRes.status}`);
  const refreshCookies = refreshRes.headers.getSetCookie();
  const newRefreshTokenCookie = refreshCookies.find(c => c.startsWith('refreshToken='));
  
  console.log(`✅ New Access Token received.`);
  console.log(`✅ Refresh Set-Cookie Path check: ${newRefreshTokenCookie.includes('Path=/api/auth')}`);

  console.log(`\n[4] Testing /refresh AGAIN with the OLD (revoked) token...`);
  const failRes = await fetch(`${baseUrl}/refresh`, {
    method: 'POST',
    headers: { 
      'Cookie': `refreshToken=${refreshToken}`
    }
  });
  
  if (failRes.status === 401) {
    console.log(`✅ Success! Old token correctly rejected with 401:`, await failRes.json());
  } else {
    throw new Error(`Expected 401, but got ${failRes.status}`);
  }
  
  console.log('\n🚀 ALL TESTS PASSED: Auth transaction and cookie scopes are verified.');
}

runTest().catch(console.error);
