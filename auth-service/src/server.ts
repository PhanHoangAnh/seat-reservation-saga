import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';

const server = fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } }
  }
});

server.register(cors, {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false,
  credentials: true
});
server.register(cookie);
server.register(rateLimit, {
  max: 10,
  timeWindow: '1 minute'
});

server.register(authRoutes);

const start = async () => {
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' });
  } catch (err) { server.log.error(err); process.exit(1); }
};
start();
