import 'dotenv/config';
import fastify from 'fastify';
import { paymentRoutes } from './routes/payment.js';
import { startWebhookWorker } from './workers/webhook-worker.js';

const server = fastify({ 
  logger: { 
    level: 'info', 
    transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } 
  } 
});

// Register the modular payment endpoints
server.register(paymentRoutes);

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3003', 10);
    await server.listen({ port, host: '0.0.0.0' });
    
    // Fire up the asynchronous background inbox processing poller daemon loop
    startWebhookWorker(server.log);
  } catch (err) { 
    server.log.error(err); 
    process.exit(1); 
  }
};
start();
