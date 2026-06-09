/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('payment_status', ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED']);

  pgm.createTable('payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transaction_id: { type: 'uuid', notNull: true }, // Saga reference
    user_id: { type: 'varchar(255)', notNull: true },
    amount: { type: 'integer', notNull: true }, // Stored in cents
    currency: { type: 'varchar(3)', notNull: true, default: 'usd' },
    status: { type: 'payment_status', notNull: true, default: 'PENDING' },
    // Unique constraint on Stripe ID enforces strict idempotency at the DB level
    stripe_payment_intent_id: { type: 'varchar(255)', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
  });

  // Append-only audit trail for webhook events
  pgm.createTable('payment_audit_logs', {
    id: { type: 'serial', primaryKey: true },
    payment_intent_id: { type: 'varchar(255)', notNull: true },
    event_type: { type: 'varchar(255)', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
  });

  // Indexes for fast lookups by the Orchestrator and Webhook processor
  pgm.createIndex('payments', 'transaction_id');
  pgm.createIndex('payments', 'stripe_payment_intent_id');
  pgm.createIndex('payment_audit_logs', 'payment_intent_id');
};

exports.down = (pgm) => {
  pgm.dropTable('payment_audit_logs');
  pgm.dropTable('payments');
  pgm.dropType('payment_status');
};
