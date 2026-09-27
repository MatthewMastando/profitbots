import { reason, signed } from "./format";
import type { Toast } from "./useFeed";

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const closing = t.purpose !== "open" && t.purpose !== "add";
        const net = t.realisedUsd - t.feeUsd;
        return (
          <div key={t.id} className="toast">
            <div className="toast-body">
              <div className="toast-title">{t.label}</div>
              <div className="toast-sub num">
                {reason(t.purpose)} · {t.contracts} contracts @ {t.px} · fee ${t.feeUsd.toFixed(2)}
              </div>
            </div>
            {closing && <div className={`toast-pnl num ${net >= 0 ? "good" : "bad"}`}>{signed(net)}</div>}
          </div>
        );
      })}
    </div>
  );
}
