import 'dotenv/config';
import fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import PgBoss from 'pg-boss';
import { paymentRoutes } from './routes/payment.js';

const server = fastify({ 
  logger: { 
    level: 'info', 
    transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } 
  } 
});

// SEC-06 Fix: Register raw-body parser immediately after server instantiation
server.register(rawBody, { global: false, encoding: 'utf8' });

// Register the payment API routes
server.register(paymentRoutes);

const boss = new PgBoss(process.env.DATABASE_URL!);
boss.on('error', error => server.log.error(error));

const start = async () => {
  try {
    await boss.start();

    // SAGA Execution Worker: Process payments requested by the reservation service
    await boss.work('process-payment', async (jobs: any) => {
      const jobArray = Array.isArray(jobs) ? jobs : [jobs];
      for (const job of jobArray) {
        const { seatId, userId, amount } = job.data;
        server.log.info(`Processing payment for seat ${seatId}, user ${userId}, amount ${amount}`);
        
        try {
          // In a real system, you'd trigger Stripe here. 
          // If it fails, we trigger the compensation job back to the reservation service.
          const paymentSuccess = true; 
          
          if (!paymentSuccess) throw new Error('Payment gateway declined');
        } catch (err: any) {
          server.log.error(`Payment failed for seat ${seatId}: ${err.message}`);
          await boss.send('cancel-reservation', { seatId, userId });
        }
      }
    });

    const port = parseInt(process.env.PORT || '3003', 10);
    await server.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
