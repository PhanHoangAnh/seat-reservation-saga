import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import crypto from 'crypto';
import { pool, WEBHOOK_SECRET } from '../config/db.js';

const stripe = new Stripe('sk_test_mock_assessment_key', { apiVersion: '2023-10-16' as any });

export async function paymentRoutes(server: FastifyInstance) {
  
  server.post('/payments/intent', async (request, reply) => {
    const { transactionId, userId, amount } = request.body as any;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const existing = await client.query('SELECT stripe_payment_intent_id, status FROM payments WHERE transaction_id = $1', [transactionId]);
      if (existing.rowCount && existing.rowCount > 0) {
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

  server.get('/payments/status/:transactionId', async (request, reply) => {
    const { transactionId } = request.params as any;
    const res = await pool.query('SELECT status FROM payments WHERE transaction_id = $1', [transactionId]);
    if (!res.rowCount || res.rowCount === 0) return { transactionId, status: 'NOT_FOUND' };
    return { transactionId, status: res.rows[0].status };
  });

  // SEC-06 Fix: Route explicitly configures rawBody extraction to prevent signature corruption
  server.post('/payments/webhook', { config: { rawBody: true } }, async (request, reply) => {
    const signatureHeader = request.headers['stripe-signature'] as string;
    if (!signatureHeader) return reply.status(401).send({ error: 'Missing signature' });

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

    // Capture the unparsed wire-buffer for HMAC hashing rather than stringifying an object map
    const rawBodyBuffer = (request as any).rawBody;
    const signedPayload = `${sigParts.t}.${rawBodyBuffer}`;
    const expectedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const providedBuffer = Buffer.from(sigParts.v1);

    if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return reply.status(401).send({ error: 'Signature mismatch' });
    }

    const payload = request.body as any;
    const eventId: string = payload.id || payload.paymentIntentId || `evt_${Date.now()}`;

    await pool.query(
      `INSERT INTO webhook_inbox (event_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, JSON.stringify(payload)]
    );

    return reply.status(200).send({ received: true });
  });

  server.post('/payments/:intentId/refund', async (request, reply) => {
    const { intentId } = request.params as any;
    const res = await pool.query(
      `UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE stripe_payment_intent_id = $1 AND status = 'COMPLETED' RETURNING id`,
      [intentId]
    );
    return { status: 'REFUNDED', refunded: (res.rowCount ?? 0) > 0 };
  });
}
