// Trigger the weekly brain writeup from the CLI.
import { POST } from '../src/app/api/cron/weekly/route';

async function main() {
  const secret = process.env.AGBRO_CRON_SECRET ?? '';
  const res = await POST(
    new Request('http://local/cron/weekly', {
      method: 'POST',
      headers: { 'x-agbro-cron-secret': secret },
    })
  );
  console.log(await res.json());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
