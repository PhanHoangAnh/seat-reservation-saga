import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import PgBoss from 'pg-boss';

const server = fastify({ logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } } });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const boss = new PgBoss(process.env.DATABASE_URL!);

boss.on('error', error => server.log.error(error));

server.get('/seats', async () => {
  const res = await pool.query('SELECT id, seat_number, status, held_until FROM public.seats ORDER BY seat_number ASC');
  return { seats: res.rows };
});

server.post('/seats/:id/hold', async (request, reply) => {
  const { id } = request.params as any;
  const { userId } = request.body as any;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Concurrency Fix: FOR UPDATE NOWAIT prevents connection pool exhaustion
    let seatRes;
    try {
      seatRes = await client.query('SELECT status FROM public.seats WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    } catch (lockErr: any) {
      if (lockErr.code === '55P03') { // 55P03 = lock_not_available
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'SEAT_LOCKED_BY_ANOTHER_USER' });
      }
      throw lockErr;
    }
    
    if (seatRes.rowCount === 0) { await client.query('ROLLBACK'); return reply.status(404).send({ error: 'Not found' }); }
    if (seatRes.rows[0].status !== 'AVAILABLE') { await client.query('ROLLBACK'); return reply.status(409).send({ error: 'UNAVAILABLE' }); }
    
    await client.query(`UPDATE public.seats SET status = 'HELD', held_by_user_id = $1, held_until = NOW() + INTERVAL '10 minutes' WHERE id = $2`, [userId, id]);
    await client.query('COMMIT');
    return { status: 'HELD', seatId: id };
  } catch (err) { 
    await client.query('ROLLBACK'); 
    throw err; 
  } finally { 
    client.release(); 
  }
});

server.post('/seats/:id/reserve', async (request, reply) => {
  const { id } = request.params as any; const { userId } = request.body as any;
  const res = await pool.query(`UPDATE public.seats SET status = 'RESERVED', reserved_by_user_id = $1, reserved_at = NOW(), held_by_user_id = NULL, held_until = NULL WHERE id = $2 AND status = 'HELD' AND held_by_user_id = $3 RETURNING id`, [userId, id, userId]);
  if ((res.rowCount ?? 0) === 0) return reply.status(400).send({ error: 'Cannot reserve' });
  return { status: 'RESERVED', seatId: id };
});

server.post('/seats/:id/release', async (request, reply) => {
  const { id } = request.params as any; const { userId } = request.body as any;
  const res = await pool.query(`UPDATE public.seats SET status = 'AVAILABLE', held_by_user_id = NULL, held_until = NULL WHERE id = $2 AND status = 'HELD' AND held_by_user_id = $1 RETURNING id`, [userId, id]);
  return { status: 'AVAILABLE', seatId: id, released: (res.rowCount ?? 0) > 0 };
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3002', 10);
    await boss.start();
    await boss.createQueue('cleanup-expired-holds');
    await boss.schedule('cleanup-expired-holds', '*/2 * * * *'); 
    await boss.work('cleanup-expired-holds', async () => {
      const res = await pool.query(`UPDATE public.seats SET status = 'AVAILABLE', held_by_user_id = NULL, held_until = NULL WHERE status = 'HELD' AND held_until < NOW()`);
      if ((res.rowCount ?? 0) > 0) server.log.info(`Released ${(res.rowCount ?? 0)} expired seat holds.`);
    });
    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();
