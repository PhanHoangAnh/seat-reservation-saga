import 'dotenv/config';
import fastify from 'fastify';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import cors from '@fastify/cors';
import bcrypt from 'bcrypt';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

const server = fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } }
  }
});

// Security: Restrict CORS and add Rate Limiting
server.register(cors, { origin: process.env.CORS_ORIGIN || '*' });
server.register(cookie);
server.register(rateLimit, {
  max: 10, // Limit each IP to 10 requests per timeWindow
  timeWindow: '1 minute'
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_123';
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

// Code Quality: Strict JSON Schema Validation
const authSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 255 }, // Basic string validation to avoid ajv-formats dependency overhead
      password: { type: 'string', minLength: 8, maxLength: 128 }
    },
    additionalProperties: false
  }
};

// Code Quality: Remove 'as any' with strict TypeScript Interfaces
interface AuthBody {
  email: string;
  password: string;
}

server.post<{ Body: AuthBody }>('/register', { schema: authSchema }, async (request, reply) => {
  const { email, password } = request.body; // No more 'as any'
  const hash = await bcrypt.hash(password, 12);
  try {
    const res = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, hash]);
    return reply.status(201).send({ userId: res.rows[0].id });
  } catch (err: any) {
    if (err.code === '23505') return reply.status(409).send({ error: 'Email exists' });
    throw err;
  }
});

server.post<{ Body: AuthBody }>('/login', { schema: authSchema }, async (request, reply) => {
  const { email, password } = request.body; // No more 'as any'
  
  const userRes = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  
  if (userRes.rowCount === 0) {
    await bcrypt.compare(password, '$2b$12$dummyhashdummyhashdummyhashdummyhashdummyhashdummyhash');
    return reply.status(401).send({ error: 'Invalid credentials' });
  }

  const { id: userId, password_hash } = userRes.rows[0];
  const isValid = await bcrypt.compare(password, password_hash);

  if (!isValid) return reply.status(401).send({ error: 'Invalid credentials' });

  const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenHash = hashToken(refreshToken);
  
  await pool.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 days')`, 
    [userId, refreshTokenHash]
  );
  
  return reply
    .setCookie('refreshToken', refreshToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60
    })
    .send({ accessToken });
});

server.post('/refresh', async (request, reply) => {
  const { refreshToken } = request.cookies;
  if (!refreshToken) return reply.status(401).send({ error: 'Missing token' });

  const hash = hashToken(refreshToken);
  
  const res = await pool.query(
    'UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING user_id',
    [hash]
  );

  if (res.rowCount === 0) {
    return reply.clearCookie('refreshToken', { path: '/' }).status(401).send({ error: 'Session expired or revoked' });
  }

  const userId = res.rows[0].user_id;
  const newAccessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '15m' });
  const newRefreshToken = crypto.randomBytes(40).toString('hex');
  const newHash = hashToken(newRefreshToken);

  await pool.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 days')`,
    [userId, newHash]
  );

  return reply
    .setCookie('refreshToken', newRefreshToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60
    })
    .send({ accessToken: newAccessToken });
});

server.post('/logout', async (request, reply) => {
  const { refreshToken } = request.cookies;
  if (refreshToken) {
    await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1', [hashToken(refreshToken)]);
  }
  return reply.clearCookie('refreshToken', { path: '/' }).send({ status: 'revoked' });
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
