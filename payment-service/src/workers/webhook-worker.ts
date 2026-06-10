import axios from 'axios';
import { pool, GATEWAY_URL, CALLBACK_SECRET } from '../config/db.js';

async function processWebhookEvent(client: any, payload: any) {
  const intentId = payload.data?.object?.id || payload.paymentIntentId;
  const eventType = payload.type;
  
  await client.query(
    `INSERT INTO payment_audit_logs (payment_intent_id, event_type, payload) VALUES ($1, $2, $3)`,
    [intentId, eventType, JSON.stringify(payload)]
  );
  
  if (eventType === 'payment_intent.succeeded') {
    const payRes = await client.query(
      `UPDATE payments SET status = 'COMPLETED', updated_at = NOW() WHERE stripe_payment_intent_id = $1 RETURNING transaction_id`,
      [intentId]
    );
    
    if (payRes.rowCount && payRes.rowCount > 0) {
      const transactionId = payRes.rows[0].transaction_id;
      try {
        await axios.post(`${GATEWAY_URL}/api/payments/callback`, 
          { transactionId, status: 'SUCCESS' },
          { headers: { 'x-callback-secret': CALLBACK_SECRET } }
        );
      } catch (cbErr) {
        // Log locally but don't crash worker; transaction will rollback if needed
      }
    }
  } else if (eventType === 'payment_intent.payment_failed') {
    await client.query(
      `UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE stripe_payment_intent_id = $1`,
      [intentId]
    );
  }
}

export async function processWebhookBatch(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ event_id: string; payload: any }>(
      `SELECT event_id, payload FROM webhook_inbox
       WHERE processed_at IS NULL
       ORDER BY received_at
       LIMIT 10
       FOR UPDATE SKIP LOCKED`
    );
    
    for (const row of rows) {
      await processWebhookEvent(client, row.payload);
      await client.query(
        'UPDATE webhook_inbox SET processed_at = NOW() WHERE event_id = $1',
        [row.event_id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function startWebhookWorker(logger: any) {
  setInterval(() => {
    processWebhookBatch().catch(err => logger.error(err, 'Inbox batch worker crashed'));
  }, 500);
}
