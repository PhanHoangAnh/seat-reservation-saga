const crypto = require('crypto');

const baseUrl = 'http://localhost:3003';
const transactionId = Math.floor(Math.random() * 1000000);
const webhookSecret = 'whsec_mock_secret_value_123';

async function runTest() {
  console.log(`[1] Creating a pending payment intent for Transaction: ${transactionId}...`);
  const intentRes = await fetch(`${baseUrl}/payments/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, userId: 42, amount: 150000 })
  });
  
  if (!intentRes.ok) throw new Error('Failed to initialize payment intent');
  const { paymentIntentId, status } = await intentRes.json();
  console.log(`✅ Intent generated: ${paymentIntentId} [Initial Status: ${status}]`);

  console.log('\n[2] Constructing and signing mock Stripe webhook payload...');
  const timestamp = Math.floor(Date.now() / 1000);
  const webhookBody = {
    id: `evt_test_${Date.now()}`,
    type: 'payment_intent.succeeded',
    paymentIntentId: paymentIntentId
  };
  
  const signedPayload = `${timestamp}.${JSON.stringify(webhookBody)}`;
  const signature = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  const stripeSignatureHeader = `t=${timestamp},v1=${signature}`;

  console.log('[3] Dispatching signed webhook to the fast-ack route...');
  const webhookRes = await fetch(`${baseUrl}/payments/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': stripeSignatureHeader
    },
    body: JSON.stringify(webhookBody)
  });

  if (!webhookRes.ok) {
    const errText = await webhookRes.text();
    throw new Error(`Webhook ingestion failed: ${errText}`);
  }
  console.log('✅ Webhook accepted with fast-ack response.');

  console.log('\n[4] Polling transaction status to verify asynchronous background worker execution...');
  let completed = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusRes = await fetch(`${baseUrl}/payments/status/${transactionId}`);
    const currentData = await statusRes.json();
    
    console.log(` -> Poll #${i + 1}: Current Status = [${currentData.status}]`);
    if (currentData.status === 'COMPLETED') {
      completed = true;
      break;
    }
  }

  if (completed) {
    console.log('\n🚀 ALL TESTS PASSED: Modular payment service and background daemon are fully operational!');
  } else {
    throw new Error('FAIL: Asynchronous background batch processing loop timed out.');
  }
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
