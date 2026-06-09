import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import axios from 'axios';
import cors from '@fastify/cors';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });
server.register(cors, { origin: '*' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const AUTH_SVC = process.env.AUTH_SVC || 'http://127.0.0.1:3001';
const RES_SVC = process.env.RES_SVC || 'http://127.0.0.1:3002';
const PAY_SVC = process.env.PAY_SVC || 'http://127.0.0.1:3003';

server.addHook('preHandler', async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    // Skip auth for GET /api/seats AND the callback route
    if ((request.method !== 'GET' || request.url !== '/api/seats') && request.url !== '/api/payments/callback') {
      try {
        const authRes = await axios.get(`${AUTH_SVC}/verify`, { headers: { authorization: request.headers.authorization } });
        (request as any).user = authRes.data.user;
      } catch (err) { return reply.status(401).send({ error: 'Unauthorized' }); }
    }
  }
});

server.get('/api/seats', async () => {
  const res = await axios.get(`${RES_SVC}/seats`);
  return res.data;
});

server.post('/api/book', async (request, reply) => {
  const { seatId } = request.body as any;
  const userId = (request as any).user.userId;


  const sagaRes = await pool.query(`INSERT INTO saga_logs (user_id, seat_id, status) VALUES ($1, $2, 'PENDING') RETURNING transaction_id`, [userId, seatId]);
  const transactionId = sagaRes.rows[0].transaction_id;
  
  
    
  

  try {
    // FAIL TEST: Simulate payment failure
    if (seatId === 999) {
      throw new Error('SIMULATED_PAYMENT_FAILURE');
    }

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
  const { transactionId, status } = request.body as any;

  if (status !== 'SUCCESS') {
    return reply.status(400).send({ error: 'Payment failed' });
  }

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

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000', 10);
    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();