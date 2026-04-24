// Tiny inline SVG sparkline — no chart library, just a polyline. Sized
// to fit between the symbol label and the value pill on a holdings
// row (~80×24 by default). Gives a two-second read of the shape
// without needing to tap into the full chart. Green when the last
// point is above the first, red below, neutral when flat.

type Props = {
  values: number[];
  width?: number;
  height?: number;
};

export function Sparkline({ values, width = 80, height = 24 }: Props) {
  if (values.length < 2) {
    // Empty / single-point state. Render a dotted midline so the row
    // layout doesn't shift.
    return (
      <svg width={width} height={height} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = values[values.length - 1] >= values[0];
  const flat = values[values.length - 1] === values[0];
  const color = flat ? 'text-ink-400' : up ? 'text-emerald-400' : 'text-rose-400';
  return (
    <svg width={width} height={height} aria-hidden className={color}>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
