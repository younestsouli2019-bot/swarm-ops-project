/**
 * Finance Control Plane — Barrel Export
 *
 * Six independent planes:
 *   1. REVENUE PLANE   — discovers + records revenue
 *   2. VERIFICATION PLANE — proves revenue actually exists
 *   3. PAYOUT PLANE    — calculates what can legally/operationally be paid
 *   4. APPROVAL PLANE  — owner authorization / limits
 *   5. SETTLEMENT PLANE — payment providers / bank rails
 *   6. RECONCILIATION PLANE — proves money actually arrived
 *
 * Golden rule: No component is allowed to promote money from one state
 * to the next without evidence.
 */

export {
  // State model
  type MoneyState,
  type TerminalState,
  ACTIVE_STATES,
  TERMINAL_STATES,
  type MoneyFlow,
  type StateTransition,
  type SettlementProof,
  type TransitionEvidence,
  TRANSITION_EVIDENCE,
  canTransition,
  getRequiredEvidence,
  validateTransition,
  promoteFlow,
  generateIdempotencyKey,
  isTestFlow,
  shouldCountInTotals,
  maskAccount,
  maskIBAN,
  maskAmount,
} from "./money-state";

export {
  // Settlement adapters
  type SettlementAdapter,
  type SettlementResult,
  type SettlementStatus,
  PayoneerAdapter,
  BankingCircleAdapter,
  ManualAdapter,
  getSettlementAdapter,
  getBestAdapter,
} from "./settlement-adapter";

export {
  // Payout engine
  PayoutEngine,
} from "./payout-engine";

export {
  // Reconciliation
  type ReconciliationStatus,
  type ReconciliationItem,
  type ReconciliationReport,
  runReconciliation,
  formatReconciliationReport,
} from "./reconciliation";
