const baseUrl = 'http://localhost:3002';
const seatIdToTest = 1;
// Generate a compliant v4 UUID for the test
const mockUserId = '550e8400-e29b-41d4-a716-446655440000';

async function runTest() {
  console.log('[1] Establishing long-running connection to Server-Sent Events stream...');
  const controller = new AbortController();
  
  const streamResponse = await fetch(`${baseUrl}/reservations/seats/stream`, {
    signal: controller.signal
  });

  if (!streamResponse.ok) throw new Error('Failed to connect to SSE stream engine');
  console.log('✅ Connection initialized successfully.');

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();

  setTimeout(async () => {
    console.log(`\n[3] Triggering mock hold (User: ${mockUserId}) on Seat ID: ${seatIdToTest}...`);
    const actionRes = await fetch(`${baseUrl}/seats/${seatIdToTest}/hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: mockUserId })
    });
    
    if (!actionRes.ok && actionRes.status !== 409) {
      throw new Error(`Action invocation failed: ${actionRes.statusText}`);
    }
    console.log('✅ Seat update action completed.');
  }, 1500);

  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes('event: seatUpdate')) {
      console.log('\n[4] Intercepting streaming message delta blocks:');
      console.log(buffer.trim());
      controller.abort();
      console.log('\n🚀 ALL TESTS PASSED: SSE Event Stream engine is operational!');
      process.exit(0);
    }
  }
}

runTest().catch(err => {
  if (err.name === 'AbortError') return;
  console.error(err);
  process.exit(1);
});
