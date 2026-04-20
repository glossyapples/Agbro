export default function DisclaimerPage() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-semibold">Disclaimer</h1>
      </header>

      <section className="card text-sm leading-relaxed text-ink-200">
        <p className="text-amber-300">
          <strong>AgBro is an experimental, AI-driven trading tool. It is not a registered broker,
          investment adviser, fiduciary, or financial professional of any kind.</strong>
        </p>

        <p className="mt-3">
          Nothing in this app is financial, tax, or legal advice. The software places real orders
          through Alpaca Markets on the account you connect. Markets carry risk. You can lose part
          or all of the money you deposit.
        </p>

        <p className="mt-3">
          The author's personal rule of thumb — and the spirit of AgBro — is simple:
        </p>
        <blockquote className="mt-2 border-l-2 border-brand-500 pl-3 italic text-ink-100">
          "If I walked into a casino planning to spend $200, that would be my budget here."
        </blockquote>
        <p className="mt-3">
          Treat AgBro like entertainment capital, not rent money, tuition, emergency savings, or
          retirement funds. The $100–$1,000 range is what this tool was designed for. It is not
          appropriate for your life savings.
        </p>

        <p className="mt-3">
          AgBro is optimised for preservation of principal and long-term value investing. It does
          not guarantee positive returns. Past performance does not predict future results. No
          software — including this one — can guarantee it "virtually never loses money". It will
          sometimes be wrong.
        </p>

        <p className="mt-3">
          By using AgBro you acknowledge that:
        </p>
        <ul className="mt-2 list-disc pl-5 text-ink-200">
          <li>You have read and understood this disclaimer.</li>
          <li>You accept full responsibility for any losses.</li>
          <li>You will not deposit funds you cannot afford to lose.</li>
          <li>AgBro's authors and contributors are not liable for losses, missed gains, or damages.</li>
          <li>You will comply with all applicable laws and Alpaca's terms.</li>
        </ul>

        <p className="mt-3 text-xs text-ink-400">
          If any of this makes you uncomfortable, do not deposit funds. That is itself a good decision.
        </p>
      </section>
    </div>
  );
}
