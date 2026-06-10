const crypto = require('crypto');

const baseUrl = 'http://localhost:3003';
const secret = 'super_secret_webhook_key_123';
const transactionId = Math.floor(Math.random() * 1000000);

async function runTest() {
  console.log(`[1] Creating Payment Intent...`);
  const intentRes = await fetch(`${baseUrl}/payments/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, userId: 1, amount: 5000 })
  });
  const intentData = await intentRes.json();
  console.log(`✅ Intent created: ${intentData.paymentIntentId}`);

  console.log(`\n[2] Simulating Stripe Webhook...`);
  const payload = {
    id: `evt_test_${Date.now()}`,
    type: 'payment_intent.succeeded',
    data: { object: { id: intentData.paymentIntentId } }
  };
  
  const payloadStr = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payloadStr}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const webhookRes = await fetch(`${baseUrl}/payments/webhook`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Stripe-Signature': `t=${timestamp},v1=${signature}`
    },
    body: payloadStr
  });
  
  console.log(`✅ Webhook Ack Status: ${webhookRes.status}`);
  console.log(`✅ Webhook Ack Body:`, await webhookRes.json());
  
  console.log(`\n[3] Waiting 1 second for async worker to process...`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log(`🚀 Test execution finished. Checking DB next.`);
}

runTest().catch(console.error);
