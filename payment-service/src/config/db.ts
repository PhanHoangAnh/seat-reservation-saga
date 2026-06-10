import { Pool } from 'pg';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`CRITICAL STARTUP ERROR: Missing required environment variable [${key}].`);
  }
  return val;
}

export const DATABASE_URL = requireEnv('DATABASE_URL');
export const WEBHOOK_SECRET = requireEnv('WEBHOOK_SECRET');
export const CALLBACK_SECRET = requireEnv('PAYMENT_CALLBACK_SECRET');
export const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';

export const pool = new Pool({ connectionString: DATABASE_URL });
