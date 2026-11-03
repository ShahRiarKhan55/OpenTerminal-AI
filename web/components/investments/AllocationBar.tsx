import { formatPercent, formatYen, type SummaryDto } from "../../lib/investments";

export const ALLOCATION_COLORS = ["#ff9900", "#4fc3f7", "#9575cd", "#81c784", "#f06292", "#fff176", "#90a4ae", "#ffb74d"];

/** Stacked bar + legend of each priced holding's share of total market value. Unpriced holdings are not part of it. */
export default function AllocationBar({ allocation, colorOf }: { allocation: SummaryDto["allocation"]; colorOf: (id: number) => string }) {
  if (allocation.length === 0) return <div className="dim text-[11px]">No priced holdings yet, so there is nothing to allocate.</div>;
  const known = allocation.filter((a) => a.pct !== null);
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden border border-[var(--border)]" role="img" aria-label={`Allocation: ${known.map((a) => `${a.name} ${formatPercent(a.pct)}`).join(", ")}`}>
        {known.map((a) => (
          <div key={a.id} style={{ width: `${a.pct}%`, background: colorOf(a.id) }} title={`${a.name}: ${formatPercent(a.pct)}`} />
        ))}
      </div>
      <table className="data-table mt-2">
        <thead>
          <tr><th>Asset</th><th>Value</th><th>Share</th></tr>
        </thead>
        <tbody>
          {allocation.map((a) => (
            <tr key={a.id}>
              <td><span className="inline-block w-2 h-2 mr-1.5 align-middle" style={{ background: colorOf(a.id) }} />{a.name}</td>
              <td>{formatYen(a.value)}</td>
              <td className="amber">{formatPercent(a.pct, false, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
