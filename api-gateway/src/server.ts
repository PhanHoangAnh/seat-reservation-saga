import 'dotenv/config';
import fastify from 'fastify';
import axios from 'axios';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });

const AUTH_SVC = process.env.AUTH_SVC || 'http://auth:3001';
const RES_SVC = process.env.RES_SVC || 'http://reservation:3002';
const PAY_SVC = process.env.PAY_SVC || 'http://payment:3003';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
const CALLBACK_SECRET = requireEnv('PAYMENT_CALLBACK_SECRET');
const REDIS_URL = requireEnv('REDIS_URL');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(REDIS_URL);

async function getCachedToken(token: string) {
  const raw = await redis.get(`jwt:${token}`);
  return raw ? JSON.parse(raw) : null;
}

async function setCachedToken(token: string, data: any, ttlSeconds: number) {
  await redis.setex(`jwt:${token}`, ttlSeconds, JSON.stringify(data));
}

server.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/auth') || request.url.startsWith('/api/payments/webhook')) return;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' });

  const token = authHeader.split(' ')[1];

  try {
    const cachedUser = await getCachedToken(token);
    if (cachedUser) {
      (request as any).user = cachedUser;
      return;
    }

    const res = await axios.get(`${AUTH_SVC}/verify`, { headers: { Authorization: authHeader } });
    (request as any).user = res.data.user;
    
    await setCachedToken(token, res.data.user, 30);
    
  } catch (err: any) {
    server.log.warn(`Token verification failed: ${err.message}`);
    return reply.status(401).send({ error: 'Invalid token' });
  }
});

server.get('/api/seats/stream', async (request, reply) => {
  try {
    const upstream = await axios.get(`${RES_SVC}/reservations/seats/stream`, {
      responseType: 'stream', 
      headers: { accept: 'text/event-stream' }
    });
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    upstream.data.pipe(reply.raw);
  } catch (err: any) {
    server.log.error(`SSE Proxy Error: ${err.message}`);
    reply.status(502).send({ error: 'Bad Gateway' });
  }
});

server.all('/api/seats*', async (request, reply) => {
  const url = `${RES_SVC}${request.url.replace('/api', '')}`;
  try {
    const res = await axios({
      method: request.method, url, data: request.body, headers: { 'Content-Type': 'application/json' }
    });
    return reply.status(res.status).send(res.data);
  } catch (err: any) {
    return reply.status(err.response?.status || 500).send(err.response?.data || { error: 'Internal Server Error' });
  }
});

// GC and Recovery Daemons
const startBackgroundWorkers = () => {
  // SAGA Recovery Job (Every 1 min)
  setInterval(async () => {
    try {
      const pendingSagas = await pool.query(
        `SELECT transaction_id, seat_id, user_id FROM saga_logs WHERE status IN ('PENDING', 'COMPENSATING') AND created_at < NOW() - INTERVAL '5 minutes'`
      );
      for (const row of pendingSagas.rows) {
        server.log.warn(`Recovering stalled saga: ${row.transaction_id}`);
        try {
          await axios.post(`${RES_SVC}/seats/${row.seat_id}/release`, { userId: row.user_id });
          await pool.query(`UPDATE saga_logs SET status = 'FAILED', step_history = array_append(step_history, 'RECOVERED_BY_GATEWAY') WHERE transaction_id = $1`, [row.transaction_id]);
        } catch (e: any) {
          server.log.error(`Failed to recover saga ${row.transaction_id}: ${e.message}`);
        }
      }
    } catch (e: any) {
      server.log.error(`Saga recovery job error: ${e.message}`);
    }
  }, 60000);

  // Database Garbage Collection Job (Every 1 hour)
  setInterval(async () => {
    try {
      server.log.info('Running background database GC...');
      
      const sessionGc = await pool.query(`DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'`);
      if ((sessionGc.rowCount ?? 0) > 0) server.log.info(`GC: Purged ${(sessionGc.rowCount ?? 0)} expired sessions.`);

      const webhookGc = await pool.query(`DELETE FROM webhook_inbox WHERE received_at < NOW() - INTERVAL '7 days'`);
      if ((webhookGc.rowCount ?? 0) > 0) server.log.info(`GC: Purged ${(webhookGc.rowCount ?? 0)} old webhook records.`);
      
    } catch (e: any) {
      server.log.error(`GC Job Error: ${e.message}`);
    }
  }, 3600000); 
};

const start = async () => {
  try {
    await server.listen({ port: 3000, host: '0.0.0.0' });
    startBackgroundWorkers();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};
start();
