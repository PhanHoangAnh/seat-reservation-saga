import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';
import { Redis } from 'ioredis';
import { sseRoutes, seatUpdatesBus } from './routes/sse.js';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const boss = new PgBoss(process.env.DATABASE_URL!);
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

const SEAT_CACHE_KEY = 'seats:all';
const SEAT_CACHE_TTL = 2; // 2-second micro-cache to absorb traffic spikes

server.register(sseRoutes);

boss.on('error', error => server.log.error(error));

server.get('/seats', async () => {
  const cached = await redis.get(SEAT_CACHE_KEY);
  if (cached) return JSON.parse(cached);
  
  const res = await pool.query('SELECT id, seat_number, status, held_until FROM public.seats ORDER BY seat_number ASC');
  const result = { seats: res.rows };
  await redis.setex(SEAT_CACHE_KEY, SEAT_CACHE_TTL, JSON.stringify(result));
  
  return result;
});

server.post('/seats/:id/hold', async (request, reply) => {
  const { id } = request.params as any;
  const { userId } = request.body as any;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    let seatRes;
    try {
      seatRes = await client.query('SELECT status FROM public.seats WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    } catch (lockErr: any) {
      if (lockErr.code === '55P03') {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'SEAT_LOCKED_BY_ANOTHER_USER' });
      }
      throw lockErr;
    }
    
    if (seatRes.rowCount === 0) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Not found' }); }
    if (seatRes.rows[0].status !== 'AVAILABLE') { await client.query('ROLLBACK'); return reply.status(409).send({ error: 'UNAVAILABLE' }); }
    
    await client.query(`UPDATE public.seats SET status = 'HELD', held_by_user_id = $1, held_until = NOW() + INTERVAL '10 minutes' WHERE id = $2`, [userId, id]);
    await client.query('COMMIT');

    await redis.del(SEAT_CACHE_KEY);
    seatUpdatesBus.emit('update', { seatId: id, status: 'HELD' });

    return { status: 'HELD', seatId: id };
  } catch (err) { 
    await client.query('ROLLBACK'); 
    throw err; 
  } finally { 
    client.release(); 
  }
});

server.post('/seats/:id/reserve', async (request, reply) => {
  const { id } = request.params as any; 
  const { userId } = request.body as any;
  
  const res = await pool.query(`UPDATE public.seats SET status = 'RESERVED', reserved_by_user_id = $1, reserved_at = NOW(), held_by_user_id = NULL, held_until = NULL WHERE id = $2 AND status = 'HELD' AND held_by_user_id = $3 RETURNING id`, [userId, id, userId]);
  
  if ((res.rowCount ?? 0) === 0) return reply.status(400).send({ error: 'Cannot reserve' });

  await redis.del(SEAT_CACHE_KEY);
  seatUpdatesBus.emit('update', { seatId: id, status: 'RESERVED' });

  await boss.send('process-payment', { seatId: id, userId, amount: 100 });

  return { status: 'PENDING_PAYMENT', seatId: id };
});

server.post('/seats/:id/release', async (request, reply) => {
  const { id } = request.params as any; 
  const { userId } = request.body as any;
  
  const res = await pool.query(`UPDATE public.seats SET status = 'AVAILABLE', held_by_user_id = NULL, held_until = NULL WHERE id = $2 AND status = 'HELD' AND held_by_user_id = $1 RETURNING id`, [userId, id]);
  
  if ((res.rowCount ?? 0) > 0) {
    await redis.del(SEAT_CACHE_KEY);
    seatUpdatesBus.emit('update', { seatId: id, status: 'AVAILABLE' });
  }

  return { status: 'AVAILABLE', seatId: id, released: (res.rowCount ?? 0) > 0 };
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3002', 10);
    await boss.start();

    // SAGA Compensation Worker: Handle arrays of jobs for pg-boss compatibility
    await boss.work('cancel-reservation', async (jobs: any) => {
      const jobArray = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of jobArray) {
        const { seatId, userId } = job.data;
        server.log.warn(`Compensating transaction: Releasing seat ${seatId} for user ${userId}`);
        await pool.query(`UPDATE public.seats SET status = 'AVAILABLE', held_by_user_id = NULL, held_until = NULL WHERE id = $1`, [seatId]);
        await redis.del(SEAT_CACHE_KEY);
        seatUpdatesBus.emit('update', { seatId, status: 'AVAILABLE' });
      }
    });

    await boss.createQueue('cleanup-expired-holds');
    await boss.schedule('cleanup-expired-holds', '*/2 * * * *'); 
    await boss.work('cleanup-expired-holds', async () => {
      const targetHolds = await pool.query(`SELECT id FROM public.seats WHERE status = 'HELD' AND held_until < NOW()`);
      
      const res = await pool.query(`UPDATE public.seats SET status = 'AVAILABLE', held_by_user_id = NULL, held_until = NULL WHERE status = 'HELD' AND held_until < NOW()`);
      
      if ((res.rowCount ?? 0) > 0) {
        server.log.info(`Released ${(res.rowCount ?? 0)} expired seat holds.`);
        await redis.del(SEAT_CACHE_KEY);
        for (const row of targetHolds.rows) {
          seatUpdatesBus.emit('update', { seatId: row.id, status: 'AVAILABLE' });
        }
      }
    });

    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();
