// Eastern-Time helpers. Server may run in any timezone; trading logic anchors to ET.

const ET = 'America/New_York';

// Returns the UTC instant of the most recent midnight (00:00) in America/New_York
// relative to `now`. Handles DST by computing the ET wall clock for `now` and
// subtracting the observed ET-from-UTC offset.
export function startOfDayET(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const lookup = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  ) as Record<string, string>;

  const hour = lookup.hour === '24' ? '00' : lookup.hour;
  const etAsIfUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(hour),
    Number(lookup.minute),
    Number(lookup.second)
  );
  const offsetMs = etAsIfUtc - now.getTime();
  const midnightETAsIfUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day)
  );
  return new Date(midnightETAsIfUtc - offsetMs);
}
