// Money helpers. We store money as integer cents in BigInt, format on the edges.

export const toCents = (dollars: number): bigint =>
  BigInt(Math.round(dollars * 100));

export const fromCents = (cents: bigint | number): number => {
  const v = typeof cents === 'bigint' ? Number(cents) : cents;
  return v / 100;
};

export const formatUsd = (cents: bigint | number | null | undefined): string => {
  if (cents == null) return '—';
  return fromCents(cents).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
};

export const formatPct = (pct: number | null | undefined, digits = 2): string => {
  if (pct == null || Number.isNaN(pct)) return '—';
  return `${pct.toFixed(digits)}%`;
};
