/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create explicit ENUM for the seat state machine
  pgm.createType('seat_status', ['AVAILABLE', 'HELD', 'RESERVED']);

  pgm.createTable('seats', {
    id: { type: 'serial', primaryKey: true },
    seat_number: { type: 'integer', notNull: true, unique: true },
    status: { type: 'seat_status', notNull: true, default: 'AVAILABLE' },
    held_by_user_id: { type: 'uuid' }, 
    held_until: { type: 'timestamptz' },
    reserved_by_user_id: { type: 'uuid' },
    reserved_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') }
  });

  // Indexes for performance on concurrency queries and cleanup jobs
  pgm.createIndex('seats', 'status');
  pgm.createIndex('seats', 'held_until', { where: "status = 'HELD'" });

  // Seed exactly 3 seats to meet the strict assessment requirements
  pgm.sql(`
    INSERT INTO seats (seat_number) VALUES (1), (2), (3);
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('seats');
  pgm.dropType('seat_status');
};
