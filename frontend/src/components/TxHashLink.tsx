import { useApp, TxEntry } from '../context/AppContext';
import { txUrl, truncateAddress } from '../constants';

// Renders a short, clickable explorer link for a captured on-chain tx, matched
// by kind (or the first of several kinds, in priority order) and optionally the
// agent it refers to. When no matching tx was recorded in this browser it renders
// `fallback` (if given) or nothing.
export function TxHashLink({ chainId, kind, refId, prefix, fallback }: { chainId: string; kind: string | string[]; refId?: string; prefix?: string; fallback?: string }) {
  const { txByChain } = useApp();
  const kinds = Array.isArray(kind) ? kind : [kind];
  const list = txByChain[chainId] || [];
  let t: TxEntry | undefined;
  for (const k of kinds) { t = list.find((x) => x.kind === k && (refId === undefined || x.ref === refId)); if (t) break; }
  if (!t) return fallback ? <span className="mono" style={{ fontSize: 10, color: 'var(--color-neutral-600)' }}>{fallback}</span> : null;

  const url = txUrl(t.network, t.hash);
  const label = `${prefix ? `${prefix} ` : ''}${truncateAddress(t.hash)}`;

  // No explorer for this network: the hash is still the proof, so make it copyable
  // rather than dropping it or linking somewhere that does not resolve.
  if (!url) {
    return (
      <button
        type="button"
        className="syn-txlink syn-txlink--copy"
        title={`${t.hash} (click to copy, this network has no block explorer)`}
        onClick={() => { navigator.clipboard?.writeText(t.hash); }}
      >
        {label} ⧉
      </button>
    );
  }

  return (
    <a className="syn-txlink" href={url} target="_blank" rel="noopener noreferrer" title={t.hash}>
      {label} ↗
    </a>
  );
}
