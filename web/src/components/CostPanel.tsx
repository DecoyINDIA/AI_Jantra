import type { CostRollupView } from "../api/client";

interface Props {
  cost: CostRollupView;
}

export default function CostPanel({ cost }: Props) {
  return (
    <div className="metric-grid">
      <div className="metric">
        <span>Total</span>
        <strong>${cost.usd.toFixed(4)}</strong>
      </div>
      <div className="metric">
        <span>Input</span>
        <strong>{cost.inputTokens.toLocaleString()}</strong>
      </div>
      <div className="metric">
        <span>Output</span>
        <strong>{cost.outputTokens.toLocaleString()}</strong>
      </div>
      <div className="metric">
        <span>Grounded</span>
        <strong>{cost.groundedPrompts.toLocaleString()}</strong>
      </div>
    </div>
  );
}
