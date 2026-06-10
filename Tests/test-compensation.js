const axios = require('axios');
const GATEWAY = 'http://localhost:3000';
const AUTH = 'http://localhost:3001';

async function runTest() {
  try {
    console.log('1. Registering user for Failure Test...');
    const email = `fail_test_${Date.now()}@saga.test`;
    await axios.post(`${AUTH}/register`, { email, password: 'securepassword123' });
    const loginRes = await axios.post(`${AUTH}/login`, { email, password: 'securepassword123' });
    const token = loginRes.data.accessToken;

    console.log('2. Initiating Saga (Booking Seat 999 to trigger simulated failure)...');
    await axios.post(`${GATEWAY}/api/book`, 
      { seatId: 999 }, 
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    if (err.response && err.response.status === 500) {
      console.log('\n[PASS] Received expected 500 Error for transaction rollback.');
    } else {
      console.error('\n[FAIL] Unexpected error:', err.message);
    }
  }
}

runTest();
