const axios = require('axios');

const GATEWAY = 'http://localhost:3000';
const AUTH = 'http://localhost:3001';
const CALLBACK_SECRET = process.env.PAYMENT_CALLBACK_SECRET || 'super_secret_callback_key_123';

async function runTest() {
  try {
    console.log('1. Registering test user...');
    const email = `test_${Date.now()}@saga.test`;
    await axios.post(`${AUTH}/register`, { email, password: 'securepassword123' });

    console.log('2. Logging in...');
    const loginRes = await axios.post(`${AUTH}/login`, { email, password: 'securepassword123' });
    const token = loginRes.data.accessToken;

    console.log('3. Initiating Saga (Booking Seat 2)...');
    const bookRes = await axios.post(`${GATEWAY}/api/book`, 
      { seatId: 2 }, 
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const { transactionId } = bookRes.data;
    console.log(`   -> Saga started. Transaction ID: ${transactionId}`);

    console.log('4. Simulating Payment Success Callback...');
    await axios.post(`${GATEWAY}/api/payments/callback`, 
      { transactionId, status: 'SUCCESS' },
      { headers: { 'x-callback-secret': CALLBACK_SECRET } }
    );

    console.log('5. Verifying Final Seat State...');
    const seatsRes = await axios.get(`${GATEWAY}/api/seats`);
    const seat2 = seatsRes.data.seats.find(s => s.id === 2);
    
    if (seat2.status === 'RESERVED') {
      console.log('\n[PASS] E2E TEST: Saga Orchestration Successful!');
    } else {
      console.log('\n[FAIL] E2E TEST: Seat state is', seat2.status);
    }
  } catch (err) {
    console.error('\n[FATAL] Test execution failed:', err.response ? err.response.data : err.message);
  }
}

runTest();


