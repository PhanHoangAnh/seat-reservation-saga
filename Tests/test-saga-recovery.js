const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgres://saga_admin:supersecretpassword@localhost:5433/seat_reservation_system' });

async function runTest() {
  console.log('[1] Injecting a stale PENDING transaction (created 6 minutes ago)...');
  const insertRes = await pool.query(`
    INSERT INTO saga_logs (user_id, seat_id, status, created_at, step_history)
    VALUES (1, 42, 'PENDING', NOW() - INTERVAL '6 minutes', '{"STARTED"}')
    RETURNING transaction_id;
  `);
  const txId = insertRes.rows[0].transaction_id;
  console.log(`✅ Stale Saga row created with transaction_id: ${txId}`);

  console.log('\n[2] Waiting and polling DB until API Gateway background daemon process runs...');
  console.log('(The Gateway runs its recovery daemon every 60 seconds. Polling every 5 seconds...)');

  const startTime = Date.now();
  const timeout = 75000; // 75 seconds timeout

  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const checkRes = await pool.query('SELECT status, step_history FROM saga_logs WHERE transaction_id = $1', [txId]);
    const currentStatus = checkRes.rows[0].status;
    const history = checkRes.rows[0].step_history;

    console.log(` -> Current Status: [${currentStatus}] | Step History: ${JSON.stringify(history)}`);

    if (currentStatus !== 'PENDING') {
      console.log(`\n🚀 SUCCESS: API Gateway recovery job intercepted the stuck transaction!`);
      console.log(`Final Status resolved to: ${currentStatus}`);
      await pool.end();
      return;
    }
  }

  await pool.end();
  throw new Error('FAIL: Timeout reached. The API Gateway recovery job did not modify the transaction.');
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
