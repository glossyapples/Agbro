import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requirePageUser } from '@/lib/auth';
import { getBrokerAccount } from '@/lib/alpaca';
import { formatUsd } from '@/lib/money';
import { WalletTransferForm } from '@/components/WalletTransferForm';

export const runtime = 'nodejs';

export default async function WalletPage() {
  const user = await requirePageUser('/wallet');

  const [account, broker] = await Promise.all([
    prisma.account.findUnique({ where: { userId: user.id } }),
    getBrokerAccount().catch(() => null),
  ]);

  const alpacaCashCents = broker?.cashCents ?? BigInt(0);
  const portfolioValueCents = broker?.portfolioValueCents ?? BigInt(0);
  const walletBalanceCents = account?.walletBalanceCents ?? BigInt(0);
  const activeCashCents =
    alpacaCashCents > walletBalanceCents ? alpacaCashCents - walletBalanceCents : BigInt(0);

  const alpacaCashUsd = Number(alpacaCashCents) / 100;
  const walletUsd = Number(walletBalanceCents) / 100;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">Wallet</h1>
          <p className="mt-1 text-xs text-ink-400">
            Move cash between Active (the agent can spend) and Wallet
            (the agent cannot touch). No real Alpaca move — purely
            AgBro-side accounting.
          </p>
        </div>
        <Link href="/" className="text-xs text-brand-400">
          ← Home
        </Link>
      </header>

      <section className="card">
        <h2 className="text-sm font-semibold text-ink-100">Balances</h2>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="stat-label">Active</p>
            <p className="text-lg font-semibold text-ink-50">{formatUsd(activeCashCents)}</p>
            <p className="mt-0.5 text-[10px] text-ink-400">Agent can deploy this</p>
          </div>
          <div>
            <p className="stat-label">Wallet</p>
            <p className="text-lg font-semibold text-brand-400">{formatUsd(walletBalanceCents)}</p>
            <p className="mt-0.5 text-[10px] text-ink-400">Reserved from agent</p>
          </div>
          <div>
            <p className="stat-label">Portfolio total</p>
            <p className="text-lg font-semibold text-ink-50">{formatUsd(portfolioValueCents)}</p>
            <p className="mt-0.5 text-[10px] text-ink-400">Cash + positions</p>
          </div>
        </div>
      </section>

      <WalletTransferForm alpacaCashUsd={alpacaCashUsd} walletBalanceUsd={walletUsd} />

      <section className="card border border-ink-700/60 bg-ink-800/40 text-[11px] text-ink-300">
        <p className="font-semibold text-ink-100">How this works</p>
        <ul className="mt-1 list-inside list-disc space-y-1">
          <li>
            Alpaca holds all the cash. <em>Active</em> and <em>Wallet</em> are
            just how AgBro splits that cash between &quot;spendable by the
            agent&quot; and &quot;reserved by you.&quot;
          </li>
          <li>
            When the agent calls <code>place_trade</code>, it reads only the
            Active balance. Orders that would exceed Active are rejected
            before reaching Alpaca.
          </li>
          <li>
            Same for crypto DCA — it skips or scales down based on Active,
            not total Alpaca cash.
          </li>
          <li>
            Selling always proceeds regardless — proceeds land in Active
            cash, ready to be re-parked in Wallet if you want.
          </li>
        </ul>
      </section>

      <section className="card border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-200">
        <p className="font-semibold">Paper-trading only — for now</p>
        <p className="mt-1">
          Real bank-account transfers (ACH in / out) and crypto
          send / receive aren&apos;t exposed by Alpaca&apos;s paper API. When
          you move to live, those become available and will attach to this
          same wallet concept.
        </p>
      </section>
    </div>
  );
}
