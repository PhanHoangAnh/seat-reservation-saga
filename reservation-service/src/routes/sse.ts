import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';

// Initialize a highly responsive internal memory event bus channel for streaming signals
export const seatUpdatesBus = new EventEmitter();
seatUpdatesBus.setMaxListeners(200); // Prevent listener memory leaks under scale

export async function sseRoutes(server: FastifyInstance) {
  server.get('/reservations/seats/stream', async (request, reply) => {
    // Establish mandatory SSE headers to instruct proxies to hold the connection open
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Write an initial connection heartbeat frame to cleanly flush network buffers
    reply.raw.write('retry: 5000\n\ndata: {"status":"connected"}\n\n');

    // Listener function to catch updates and serialize them down the connection pipe
    const onSeatUpdate = (eventPayload: any) => {
      reply.raw.write(`event: seatUpdate\ndata: ${JSON.stringify(eventPayload)}\n\n`);
    };

    seatUpdatesBus.on('update', onSeatUpdate);

    // Monitor for connection termination to prevent socket leakages and clean up memory
    request.raw.on('close', () => {
      seatUpdatesBus.off('update', onSeatUpdate);
    });
  });
}
