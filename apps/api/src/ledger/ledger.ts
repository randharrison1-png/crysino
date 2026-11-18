import { createHash } from "node:crypto";
import type { AccountKind, LedgerTxnType, OwnerType } from "@crysino/shared";
import { withTransaction, type Db, type DbClient } from "../db/pool.js";

/**
 * Double-entry ledger (design spec §6).
 *
 * Every movement of money is one transaction made of legs that sum to zero per asset.
 * Player accounts can never go negative; house and external accounts can.
 * The only way balances change is postTransaction().
 */

export interface AccountRef {
  ownerType: OwnerType;
  ownerId?: string; // required for players, omitted for house/external
  asset: string;
  kind: AccountKind;
}

export interface Leg {
  account: AccountRef;
  amount: bigint; // + credit, - debit
}

export interface PostInput {
  type: LedgerTxnType;
  legs: Leg[];
  refType?: string;
  refId?: string;
  /** Same key twice returns the first transaction instead of moving money again. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  txnId: string;
  /** false when this was an idempotent replay of an earlier request. */
  created: boolean;
  /** Balance of each account touched, after the transaction. Keyed by accountKey(). */
  balances: Map<string, bigint>;
}

export class LedgerError extends Error {}
export class InsufficientFundsError extends LedgerError {
  constructor(public account: AccountRef, public balance: bigint, public required: bigint) {
    super(`Insufficient funds in ${accountKey(account)}: balance ${balance}, needs ${required}`);
  }
}
export class UnbalancedTransactionError extends LedgerError {}
export class IdempotencyConflictError extends LedgerError {}

export function accountKey(a: AccountRef): string {
  return `${a.ownerType}:${a.ownerId ?? "-"}:${a.asset}:${a.kind}`;
}

// Convenience constructors so call sites read clearly.
export const player = (ownerId: string, asset: string, kind: AccountKind = "main"): AccountRef => ({
  ownerType: "player",
  ownerId,
  asset,
  kind,
});
export const house = (asset: string, kind: AccountKind = "bankroll"): AccountRef => ({
  ownerType: "house",
  asset,
  kind,
});
export const chain = (asset: string): AccountRef => ({ ownerType: "external", asset, kind: "chain" });

function validate(input: PostInput): void {
  if (input.legs.length < 2) throw new UnbalancedTransactionError("A transaction needs at least two legs");
  const perAsset = new Map<string, bigint>();
  for (const leg of input.legs) {
    if (leg.amount === 0n) throw new UnbalancedTransactionError("Legs cannot be zero");
    if ((leg.account.ownerType === "player") !== Boolean(leg.account.ownerId)) {
      throw new LedgerError("Player accounts need an ownerId; house/external accounts must not have one");
    }
    perAsset.set(leg.account.asset, (perAsset.get(leg.account.asset) ?? 0n) + leg.amount);
  }
  for (const [asset, sum] of perAsset) {
    if (sum !== 0n) throw new UnbalancedTransactionError(`Legs for ${asset} sum to ${sum}, not 0`);
  }
}

/** Fingerprint of what a request asked for, so a reused idempotency key with different contents is caught. */
function fingerprint(input: PostInput): string {
  const legs = input.legs.map((l) => `${accountKey(l.account)}=${l.amount}`).sort();
  return createHash("sha256")
    .update(JSON.stringify([input.type, input.refType ?? null, input.refId ?? null, legs]))
    .digest("hex");
}

async function resolveAccountId(client: DbClient, a: AccountRef): Promise<string> {
  const params = [a.ownerType, a.ownerId ?? null, a.asset, a.kind, a.ownerType !== "player"];
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (owner_type, owner_id, asset, kind, allow_negative)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT one_account_per_slot DO NOTHING
     RETURNING id`,
    params,
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ledger_accounts
     WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND asset = $3 AND kind = $4`,
    params.slice(0, 4),
  );
  if (!existing.rows[0]) throw new LedgerError(`Could not resolve account ${accountKey(a)}`);
  return existing.rows[0].id;
}

async function balancesFor(client: DbClient, accounts: Map<string, string>): Promise<Map<string, bigint>> {
  const { rows } = await client.query<{ id: string; balance: string }>(
    "SELECT id, balance FROM ledger_accounts WHERE id = ANY($1::bigint[])",
    [[...accounts.values()]],
  );
  const byId = new Map(rows.map((r) => [r.id, BigInt(r.balance)]));
  return new Map([...accounts].map(([key, id]) => [key, byId.get(id) ?? 0n]));
}

/**
 * Post a transaction using an existing database transaction (`client` must be inside BEGIN).
 * Use this when the ledger change must commit atomically with other writes, e.g. a game round.
 */
export async function postWithClient(client: DbClient, input: PostInput): Promise<PostResult> {
  validate(input);
  const fp = fingerprint(input);

  // Resolve every account (creating on first use).
  const accountIds = new Map<string, string>();
  const refs = new Map<string, AccountRef>();
  for (const leg of input.legs) {
    const key = accountKey(leg.account);
    if (!accountIds.has(key)) {
      accountIds.set(key, await resolveAccountId(client, leg.account));
      refs.set(key, leg.account);
    }
  }

  // Idempotency: claim the key first. A concurrent request with the same key waits here
  // until we commit or roll back.
  const txn = await client.query<{ id: string }>(
    `INSERT INTO ledger_txns (type, ref_type, ref_id, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.type,
      input.refType ?? null,
      input.refId ?? null,
      input.idempotencyKey ?? null,
      { ...input.metadata, fingerprint: fp },
    ],
  );
  if (!txn.rows[0]) {
    const prior = await client.query<{ id: string; fp: string }>(
      "SELECT id, metadata->>'fingerprint' AS fp FROM ledger_txns WHERE idempotency_key = $1",
      [input.idempotencyKey],
    );
    const row = prior.rows[0];
    if (!row) throw new LedgerError("Idempotency key vanished; retry the request");
    if (row.fp !== fp) {
      throw new IdempotencyConflictError(
        `Idempotency key "${input.idempotencyKey}" was already used for a different transaction`,
      );
    }
    return { txnId: row.id, created: false, balances: await balancesFor(client, accountIds) };
  }
  const txnId = txn.rows[0].id;

  // Net amount per account (a transaction may touch one account twice).
  const net = new Map<string, bigint>();
  for (const leg of input.legs) {
    const key = accountKey(leg.account);
    net.set(key, (net.get(key) ?? 0n) + leg.amount);
  }

  // Lock touched accounts in a fixed order (by id) so concurrent transactions can't deadlock.
  const locked = await client.query<{ id: string; balance: string; allow_negative: boolean }>(
    `SELECT id, balance, allow_negative FROM ledger_accounts
     WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [[...accountIds.values()]],
  );
  const current = new Map(locked.rows.map((r) => [r.id, r]));

  const balances = new Map<string, bigint>();
  for (const [key, id] of accountIds) {
    const row = current.get(id)!;
    const delta = net.get(key) ?? 0n;
    const next = BigInt(row.balance) + delta;
    if (next < 0n && !row.allow_negative) {
      throw new InsufficientFundsError(refs.get(key)!, BigInt(row.balance), -delta);
    }
    balances.set(key, next);
  }

  // Write entries and updated balances.
  const legAccountIds = input.legs.map((l) => accountIds.get(accountKey(l.account))!);
  const legAmounts = input.legs.map((l) => l.amount.toString());
  await client.query(
    `INSERT INTO ledger_entries (txn_id, account_id, amount)
     SELECT $1, unnest($2::bigint[]), unnest($3::numeric[])`,
    [txnId, legAccountIds, legAmounts],
  );
  const changedIds: string[] = [];
  const changedDeltas: string[] = [];
  for (const [key, id] of accountIds) {
    const delta = net.get(key) ?? 0n;
    if (delta !== 0n) {
      changedIds.push(id);
      changedDeltas.push(delta.toString());
    }
  }
  if (changedIds.length) {
    await client.query(
      `UPDATE ledger_accounts a SET balance = a.balance + d.delta
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::numeric[]) AS delta) d
       WHERE a.id = d.id`,
      [changedIds, changedDeltas],
    );
  }

  return { txnId, created: true, balances };
}

/** Post a transaction in its own database transaction. */
export function post(db: Db, input: PostInput): Promise<PostResult> {
  return withTransaction(db, (client) => postWithClient(client, input));
}

/** Current balance of one account (0 if it has never been used). */
export async function getBalance(db: Db | DbClient, account: AccountRef): Promise<bigint> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts
     WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND asset = $3 AND kind = $4`,
    [account.ownerType, account.ownerId ?? null, account.asset, account.kind],
  );
  return rows[0] ? BigInt(rows[0].balance) : 0n;
}

/** Accounts whose cached balance disagrees with the sum of their entries. Empty = healthy. */
export async function verifyLedger(
  db: Db,
): Promise<{ accountId: string; cached: bigint; computed: bigint }[]> {
  const { rows } = await db.query<{ account_id: string; cached: string; computed: string }>(
    "SELECT * FROM verify_ledger()",
  );
  return rows.map((r) => ({ accountId: r.account_id, cached: BigInt(r.cached), computed: BigInt(r.computed) }));
}
