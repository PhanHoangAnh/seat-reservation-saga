import { Pool } from 'pg';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`CRITICAL STARTUP ERROR: Missing required environment variable [${key}].`);
  }
  return val;
}

export const DATABASE_URL = requireEnv('DATABASE_URL');
export const JWT_SECRET = requireEnv('JWT_SECRET');

export const pool = new Pool({ connectionString: DATABASE_URL });
