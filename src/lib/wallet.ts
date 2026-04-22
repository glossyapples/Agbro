// Wallet = AgBro-side cash reservation. Alpaca holds the money, but the
// user can park a dollar amount "in the wallet" that the agent + crypto
// engine must treat as untouchable. Effective cash = Alpaca cash minus
// whatever is parked.
//
// Single source of truth for any code path that needs to answer "how much
// cash can AgBro actually deploy right now?" — place_trade pre-check,
// crypto DCA pre-check, getAccountState tool output.
//
// Design note: this does NOT talk to Alpaca. It takes the broker account
// + the Account row and does arithmetic. Keep it pure so it's trivial
// to unit-test and reason about.

export type SpendableCash = {
  // Alpaca-reported cash (for reference / UI display).
  alpacaCashCents: bigint;
  // Amount the user has explicitly reserved in the wallet.
  walletBalanceCents: bigint;
  // What the agent is allowed to see + spend. Never negative — if wallet
  // balance somehow exceeds Alpaca cash (shouldn't happen, but possible
  // if a deposit hasn't landed), we clamp to 0 rather than reporting a
  // negative buying power that breaks downstream arithmetic.
  spendableCents: bigint;
};

export function computeSpendable(args: {
  alpacaCashCents: bigint;
  walletBalanceCents: bigint;
}): SpendableCash {
  const { alpacaCashCents, walletBalanceCents } = args;
  const raw = alpacaCashCents - walletBalanceCents;
  const spendableCents = raw > BigInt(0) ? raw : BigInt(0);
  return { alpacaCashCents, walletBalanceCents, spendableCents };
}
