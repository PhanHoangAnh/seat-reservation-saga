// The strict data contract for our distributed transaction.
// The Orchestrator uses this to track what steps have succeeded so it knows what to compensate.

export type SagaStatus = 'PENDING' | 'COMPLETED' | 'COMPENSATING' | 'FAILED';

export type SagaStepType = 'HOLD_SEAT' | 'PROCESS_PAYMENT' | 'FINALIZE_RESERVATION';
export type StepStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'COMPENSATED';

export interface SagaStep {
  type: SagaStepType;
  status: StepStatus;
  startedAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

export interface SagaLog {
  transactionId: string;
  userId: string;
  seatId: number;
  status: SagaStatus;
  steps: SagaStep[];
  createdAt: Date;
  updatedAt: Date;
}
