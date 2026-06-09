/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create an ENUM for the Saga status to ensure data integrity
  pgm.createType('saga_status', ['PENDING', 'COMPLETED', 'COMPENSATING', 'FAILED']);

  pgm.createTable('saga_logs', {
    transaction_id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: { type: 'varchar(255)', notNull: true },
    seat_id: { type: 'integer', notNull: true },
    status: { type: 'saga_status', notNull: true, default: 'PENDING' },
    // JSONB is crucial here to store the array of step history flexibly
    step_history: { type: 'jsonb', notNull: true, default: '[]' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Create an index on the transaction_id for fast lookups
  pgm.createIndex('saga_logs', 'transaction_id');
};

exports.down = (pgm) => {
  pgm.dropTable('saga_logs');
  pgm.dropType('saga_status');
};
