export type OwnerType = "player" | "house" | "external";

/** Kinds of ledger account, per the design spec (§6). */
export type AccountKind =
  | "main" // player's spendable balance
  | "pending_withdrawal" // player funds locked while a withdrawal is processed
  | "bankroll" // house money that pays wins and receives losing stakes
  | "fees" // network/withdrawal fees collected
  | "adjustments" // manual admin corrections (always audited)
  | "chain"; // the outside world: deposits come from here, withdrawals go to it

export type LedgerTxnType =
  | "deposit"
  | "bet"
  | "win"
  | "refund"
  | "withdrawal_request"
  | "withdrawal_complete"
  | "withdrawal_cancel"
  | "adjustment"
  | "sweep";
