async function runTest() {
  console.log('[1] Sending a request mimicking an untrusted malicious domain...');
  
  const res = await fetch('http://localhost:3001/login', {
    method: 'POST',
    headers: {
      'Origin': 'http://malicious-domain.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'cors-test@example.com', password: 'password123' })
  });

  const allowOrigin = res.headers.get('access-control-allow-origin');
  console.log(` -> Access-Control-Allow-Origin header caught: ${allowOrigin}`);

  if (!allowOrigin) {
    console.log('\n🚀 ALL TESTS PASSED: Insecure origins are blocked from obtaining CORS headers.');
  } else {
    throw new Error(`FAIL: Security breach! Server leaked a CORS access header to an untrusted domain: ${allowOrigin}`);
  }
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
