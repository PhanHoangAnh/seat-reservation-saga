import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { hash, verify } from '@node-rs/argon2';
import { pool, JWT_SECRET } from '../config/db.js';
import { redis } from '../config/redis.js';

const ARGON2_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

let DUMMY_HASH = '';
async function initDummyHash() {
  DUMMY_HASH = await hash('dummy-password-string-123', ARGON2_OPTIONS);
}
initDummyHash().catch(() => {});

const authSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 255 }, 
      password: { type: 'string', minLength: 8, maxLength: 128 }
    },
    additionalProperties: false
  }
};

interface AuthBody {
  email: string;
  password: string;
}

// High-performance token version Cache-Aside fetching helper
async function getUserTokenVersion(userId: number): Promise<number> {
  const cacheKey = `user:${userId}:ver`;
  const cachedVer = await redis.get(cacheKey);
  
  if (cachedVer !== null) {
    return parseInt(cachedVer, 10);
  }
  
  const res = await pool.query('SELECT token_version FROM users WHERE id = $1', [userId]);
  const dbVer = res.rows[0]?.token_version ?? 0;
  
  // Cache the version constraint state locally for 1 hour
  await redis.set(cacheKey, dbVer, 'EX', 3600);
  return dbVer;
}

export async function authRoutes(server: FastifyInstance) {
  server.post<{ Body: AuthBody }>('/register', { schema: authSchema }, async (request, reply) => {
    const { email, password } = request.body; 
    const passwordHash = await hash(password, ARGON2_OPTIONS);
    try {
      const res = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, passwordHash]);
      return reply.status(201).send({ userId: res.rows[0].id });
    } catch (err: any) {
      if (err.code === '23505') return reply.status(409).send({ error: 'Email exists' });
      throw err;
    }
  });

  server.post<{ Body: AuthBody }>('/login', { schema: authSchema }, async (request, reply) => {
    const { email, password } = request.body; 
    const userRes = await pool.query('SELECT id, password_hash, token_version FROM users WHERE email = $1', [email]);
    
    if (userRes.rowCount === 0) {
      if (DUMMY_HASH) await verify(DUMMY_HASH, password);
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const { id: userId, password_hash, token_version } = userRes.rows[0];
    const isValid = await verify(password_hash, password);

    if (!isValid) return reply.status(401).send({ error: 'Invalid credentials' });

    const accessToken = jwt.sign({ userId, ver: token_version }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = hashToken(refreshToken);
    
    await pool.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 days')`, 
      [userId, refreshTokenHash]
    );

    // Warm up the cache instantly upon successful login
    await redis.set(`user:${userId}:ver`, token_version, 'EX', 3600);
    
    return reply
      .setCookie('refreshToken', refreshToken, {
        path: '/api/auth',
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW() RETURNING user_id`,
        [hash]
      );

      if ((res.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return reply.clearCookie('refreshToken', { path: '/api/auth' }).status(401).send({ error: 'Session expired or revoked' });
      }

      const userId = res.rows[0].user_id;
      const userRes = await client.query('SELECT token_version FROM users WHERE id = $1', [userId]);
      const tokenVersion = userRes.rows[0]?.token_version ?? 0;

      const newAccessToken = jwt.sign({ userId, ver: tokenVersion }, JWT_SECRET, { expiresIn: '15m' });
      const newRefreshToken = crypto.randomBytes(40).toString('hex');
      const newHash = hashToken(newRefreshToken);

      await client.query(
        `INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 days')`,
        [userId, newHash]
      );
      await client.query('COMMIT');

      // Update cache version to prevent unexpected verification drops
      await redis.set(`user:${userId}:ver`, tokenVersion, 'EX', 3600);

      return reply
        .setCookie('refreshToken', newRefreshToken, {
          path: '/api/auth',
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 90 * 24 * 60 * 60
        })
        .send({ accessToken: newAccessToken });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  server.post('/logout', async (request, reply) => {
    const { refreshToken } = request.cookies;
    if (refreshToken) {
      const hash = hashToken(refreshToken);
      const res = await pool.query(
        `UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING user_id`,
        [hash]
      );
      if ((res.rowCount ?? 0) > 0) {
        const userId = res.rows[0].user_id;
        await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
        
        // Evict key immediately from Redis cache upon explicit revocation
        await redis.del(`user:${userId}:ver`);
      }
    }
    return reply.clearCookie('refreshToken', { path: '/api/auth' }).send({ status: 'revoked' });
  });

  server.get('/verify', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return reply.status(401).send({ error: 'Missing token' });
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      
      // Look up current token version using memory cache lookaside helper
      const currentVer = await getUserTokenVersion(decoded.userId);
      if (decoded.ver !== currentVer) {
        return reply.status(401).send({ error: 'Token revoked or expired' });
      }

      return { valid: true, user: decoded };
    } catch (err) { return reply.status(401).send({ error: 'Invalid token' }); }
  });
}
