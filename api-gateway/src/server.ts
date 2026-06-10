import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import axios from 'axios';
import cors from '@fastify/cors';
import crypto from 'crypto';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });

server.register(cors, { origin: process.env.CORS_ORIGIN || 'http://localhost:3000' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const AUTH_SVC = process.env.AUTH_SVC || 'http://127.0.0.1:3001';
const RES_SVC = process.env.RES_SVC || 'http://127.0.0.1:3002';
const PAY_SVC = process.env.PAY_SVC || 'http://127.0.0.1:3003';
const CALLBACK_SECRET = process.env.PAYMENT_CALLBACK_SECRET || 'super_secret_callback_key_123';

// Phase 4, Step 9: In-Memory JWT Cache to prevent /verify spam
const VERIFY_CACHE = new Map<string, { userId: string; exp: number }>();

server.addHook('preHandler', async (request, reply) => {
  if (request.url.startsWith('/api/') && request.url !== '/api/seats' && request.url !== '/api/payments/callback') {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' });
    
    const token = authHeader.split(' ')[1];
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const cached = VERIFY_CACHE.get(key);
    
    if (cached && cached.exp > Date.now() / 1000) {
      (request as any).user = cached;
      return;
    }

    try {
      const authRes = await axios.get(`${AUTH_SVC}/verify`, { headers: { authorization: authHeader } });
      const user = authRes.data.user;
      VERIFY_CACHE.set(key, { userId: user.userId, exp: user.exp });
      setTimeout(() => VERIFY_CACHE.delete(key), 30_000); // TTL 30s
      (request as any).user = user;
    } catch (err) { return reply.status(401).send({ error: 'Unauthorized' }); }
  }
});

server.get('/api/seats', async () => {
  const res = await axios.get(`${RES_SVC}/seats`);
  return res.data;
});

// Phase 3: Eradicate `any` with Schema Validation
const bookSchema = {
  body: {
    type: 'object',
    required: ['seatId'],
    properties: { seatId: { type: 'integer' } },
    additionalProperties: false
  }
};

interface BookBody { seatId: number; }

server.post<{ Body: BookBody }>('/api/book', { schema: bookSchema }, async (request, reply) => {
  const { seatId } = request.body; // Fully typed, no 'as any'
  const userId = (request as any).user.userId;

  const sagaRes = await pool.query(`INSERT INTO saga_logs (user_id, seat_id, status) VALUES ($1, $2, 'PENDING') RETURNING transaction_id`, [userId, seatId]);
  const transactionId = sagaRes.rows[0].transaction_id;

  try {
    if (seatId === 999) throw new Error('SIMULATED_PAYMENT_FAILURE');

    await pool.query(`UPDATE saga_logs SET step_history = array_append(step_history, 'HOLDING_SEAT') WHERE transaction_id = $1`, [transactionId]);
    await axios.post(`${RES_SVC}/seats/${seatId}/hold`, { userId });

    await pool.query(`UPDATE saga_logs SET step_history = array_append(step_history, 'CREATING_PAYMENT') WHERE transaction_id = $1`, [transactionId]);
    const payRes = await axios.post(`${PAY_SVC}/payments/intent`, { transactionId, userId, amount: 5000 });

    return { transactionId, paymentIntentId: payRes.data.paymentIntentId, status: 'PAYMENT_PENDING' };
  } catch (error: any) {
    await pool.query(`UPDATE saga_logs SET status = 'COMPENSATING' WHERE transaction_id = $1`, [transactionId]);
    try { await axios.post(`${RES_SVC}/seats/${seatId}/release`, { userId }); } catch (e) { server.log.error('Failed to release seat.'); }
    await pool.query(`UPDATE saga_logs SET status = 'FAILED', step_history = array_append(step_history, 'COMPENSATED') WHERE transaction_id = $1`, [transactionId]);
    return reply.status(500).send({ error: 'Transaction failed. Seat hold rolled back.' });
  }
});

server.post('/api/payments/callback', async (request, reply) => {
  const authSecret = request.headers['x-callback-secret'] as string;
  if (!authSecret) return reply.status(401).send({ error: 'Unauthorized callback' });

  const expectedBuffer = Buffer.from(CALLBACK_SECRET);
  const providedBuffer = Buffer.from(authSecret);

  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return reply.status(401).send({ error: 'Unauthorized callback' });
  }

  const { transactionId, status } = request.body as any;
  if (status !== 'SUCCESS') return reply.status(400).send({ error: 'Payment failed' });

  const sagaRes = await pool.query('SELECT seat_id, user_id FROM saga_logs WHERE transaction_id = $1', [transactionId]);
  if (sagaRes.rowCount === 0) return reply.status(404).send({ error: 'Transaction not found' });
  
  const { seat_id, user_id } = sagaRes.rows[0];

  try {
    await pool.query(`UPDATE saga_logs SET status = 'COMPLETED', step_history = array_append(step_history, 'PAYMENT_RECEIVED') WHERE transaction_id = $1`, [transactionId]);
    await axios.post(`${RES_SVC}/seats/${seat_id}/reserve`, { userId: user_id });
    return { status: 'OK' };
  } catch (err) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to complete transaction' });
  }
});

// ASYNC SAGA RECOVERY JOB DAE MOND
async function startSagaRecovery(): Promise<void> {
  setInterval(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find sagas stuck in PENDING for more than 5 minutes
      const { rows } = await client.query<{
        transaction_id: number; seat_id: number; user_id: number
      }>(
        `SELECT transaction_id, seat_id, user_id FROM saga_logs
         WHERE status = 'PENDING'
           AND created_at < NOW() - INTERVAL '5 minutes'
         LIMIT 20
         FOR UPDATE SKIP LOCKED`
      );

      for (const saga of rows) {
        let paymentSucceeded = false;
        try {
          const payRes = await axios.get(`${PAY_SVC}/payments/status/${saga.transaction_id}`);
          paymentSucceeded = payRes.data?.status === 'COMPLETED';
        } catch (err) {
          // If payment service status route fails or is unreachable, skip execution for this tick
          continue;
        }

        if (paymentSucceeded) {
          // Payment succeeded but callback dropped out -> Complete Saga
          await client.query(
            `UPDATE saga_logs SET status = 'COMPLETED',
             step_history = array_append(step_history, 'RECOVERED_BY_JOB')
             WHERE transaction_id = $1`,
            [saga.transaction_id]
          );
          await axios.post(`${RES_SVC}/seats/${saga.seat_id}/reserve`, { userId: saga.user_id });
        } else {
          // Payment dropped or failed -> Roll back seat hold
          await client.query(
            `UPDATE saga_logs SET status = 'FAILED',
             step_history = array_append(step_history, 'EXPIRED_BY_RECOVERY_JOB')
             WHERE transaction_id = $1`,
            [saga.transaction_id]
          );
          try {
            await axios.post(`${RES_SVC}/seats/${saga.seat_id}/release`, { userId: saga.user_id });
          } catch (e) {
            server.log.error(`Failed to execute compensation release for seat ${saga.seat_id}`);
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      server.log.error(err, 'Saga recovery tick encountered an exception');
    } finally {
      client.release();
    }
  }, 60000); // Run reconciler daemon loop every 60 seconds
}

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    await server.listen({ port, host: '0.0.0.0' });
    startSagaRecovery(); // Fire up recovery daemon loop on start
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();