import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import Stripe from 'stripe';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = new Stripe('sk_test_mock_assessment_key', { apiVersion: '2023-10-16' as any });

server.post('/payments/intent', async (request, reply) => {
  const { transactionId, userId, amount } = request.body as any;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check for existing intent to enforce DB-level idempotency
    const existing = await client.query('SELECT stripe_payment_intent_id, status FROM payments WHERE transaction_id = $1', [transactionId]);
    if (existing.rowCount > 0) {
       await client.query('ROLLBACK');
       return { paymentIntentId: existing.rows[0].stripe_payment_intent_id, status: existing.rows[0].status };
    }
    
    const paymentIntentId = `pi_mock_${Date.now()}`;
    await client.query(
      `INSERT INTO payments (transaction_id, user_id, amount, stripe_payment_intent_id) VALUES ($1, $2, $3, $4)`,
      [transactionId, userId, amount, paymentIntentId]
    );
    await client.query('COMMIT');
    return { paymentIntentId, status: 'PENDING' };
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
});

server.post('/payments/webhook', async (request, reply) => {
  const payload = request.body as any;
  const intentId = payload.data?.object?.id || payload.paymentIntentId;
  const eventType = payload.type;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Write to append-only audit log immediately
    await client.query(`INSERT INTO payment_audit_logs (payment_intent_id, event_type, payload) VALUES ($1, $2, $3)`, [intentId, eventType, JSON.stringify(payload)]);
    
    // 2. Process state change
    if (eventType === 'payment_intent.succeeded') {
      await client.query(`UPDATE payments SET status = 'COMPLETED', updated_at = NOW() WHERE stripe_payment_intent_id = $1`, [intentId]);
    } else if (eventType === 'payment_intent.payment_failed') {
      await client.query(`UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE stripe_payment_intent_id = $1`, [intentId]);
    }
    
    await client.query('COMMIT');
    return { received: true };
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
});

server.post('/payments/:intentId/refund', async (request, reply) => {
  const { intentId } = request.params as any;
  const res = await pool.query(
    `UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'COMPLETED' RETURNING id`,
    [intentId]
  );
  return { status: 'REFUNDED', refunded: (res.rowCount ?? 0) > 0 };
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3003', 10);
    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();
