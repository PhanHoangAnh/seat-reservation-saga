import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import cors from '@fastify/cors';

const server = fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } }
  }
});

server.register(cors, { origin: '*' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

server.post('/register', async (request, reply) => {
  const { email, password } = request.body as any;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  try {
    const res = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, hash]);
    return reply.status(201).send({ userId: res.rows[0].id });
  } catch (err: any) {
    if (err.code === '23505') return reply.status(409).send({ error: 'Email exists' });
    throw err;
  }
});

server.post('/login', async (request, reply) => {
  const { email, password } = request.body as any;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const userRes = await pool.query('SELECT id FROM users WHERE email = $1 AND password_hash = $2', [email, hash]);
  if ((userRes.rowCount ?? 0) === 0) return reply.status(401).send({ error: 'Invalid credentials' });
  const userId = userRes.rows[0].id;
  const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenHash = hashToken(refreshToken);
  await pool.query(`INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 days')`, [userId, refreshTokenHash]);
  return { accessToken, refreshToken };
});

server.post('/logout', async (request, reply) => {
  const { refreshToken } = request.body as any;
  if (!refreshToken) return reply.status(400).send({ error: 'Missing token' });
  await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1', [hashToken(refreshToken)]);
  return { status: 'revoked' };
});

server.get('/verify', async (request, reply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { valid: true, user: decoded };
  } catch (err) { return reply.status(401).send({ error: 'Invalid token' }); }
});

const start = async () => {
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();
