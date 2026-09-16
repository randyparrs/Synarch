// Segmented reliability readout: 20 ticks, one lit per 5% (rounded). Purely a
// view of reliability_pct read from the judge, never an invented value.
export function Meter({ pct, sm }: { pct?: number; sm?: boolean }) {
  const lit = pct === undefined ? 0 : Math.max(0, Math.min(20, Math.round(pct / 5)));
  return (
    <div className={sm ? 'syn-meter syn-meter--sm' : 'syn-meter'} aria-hidden="true">
      {Array.from({ length: 20 }, (_, i) => <i key={i} className={i < lit ? 'is-lit' : ''} />)}
    </div>
  );
}
