import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import Stripe from 'stripe';
import crypto from 'crypto';
import axios from 'axios';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = new Stripe('sk_test_mock_assessment_key', { apiVersion: '2023-10-16' as any });

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'super_secret_webhook_key_123';
const CALLBACK_SECRET = process.env.PAYMENT_CALLBACK_SECRET || 'super_secret_callback_key_123';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';

server.post('/payments/intent', async (request, reply) => {
  const { transactionId, userId, amount } = request.body as any;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
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
  // Security Fix: HMAC-SHA256 Signature Verification + 120s Tolerance
  const signatureHeader = request.headers['stripe-signature'] as string;
  if (!signatureHeader) return reply.status(401).send({ error: 'Missing signature' });

  // Parse Stripe signature format: t=<timestamp>,v1=<signature>
  const sigParts = signatureHeader.split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  if (!sigParts.t || !sigParts.v1) return reply.status(401).send({ error: 'Invalid signature format' });

  const timestamp = parseInt(sigParts.t, 10);
  const now = Math.floor(Date.now() / 1000);
  
  if (Math.abs(now - timestamp) > 120) {
    return reply.status(400).send({ error: 'Webhook timestamp outside tolerance window' });
  }

  // Calculate expected HMAC
  const signedPayload = `${sigParts.t}.${JSON.stringify(request.body)}`;
  const expectedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(sigParts.v1);

  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return reply.status(401).send({ error: 'Signature mismatch' });
  }

  const payload = request.body as any;
  const intentId = payload.data?.object?.id || payload.paymentIntentId;
  const eventType = payload.type;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(`INSERT INTO payment_audit_logs (payment_intent_id, event_type, payload) VALUES ($1, $2, $3)`, [intentId, eventType, JSON.stringify(payload)]);
    
    if (eventType === 'payment_intent.succeeded') {
      const payRes = await client.query(`UPDATE payments SET status = 'COMPLETED', updated_at = NOW() WHERE stripe_payment_intent_id = $1 RETURNING transaction_id`, [intentId]);
      
      // Notify API Gateway securely
      if (payRes.rowCount > 0) {
        const transactionId = payRes.rows[0].transaction_id;
        try {
          await axios.post(`${GATEWAY_URL}/api/payments/callback`, 
            { transactionId, status: 'SUCCESS' },
            { headers: { 'x-callback-secret': CALLBACK_SECRET } }
          );
        } catch (cbErr) {
          server.log.error('Failed to notify gateway callback');
        }
      }
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
