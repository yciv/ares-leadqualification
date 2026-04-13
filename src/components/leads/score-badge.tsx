const FLAG_STYLES: Record<string, string> = {
  AE:      "bg-status-success/15 text-status-success",
  SDR:     "bg-status-warning/15 text-status-warning",
  nurture: "bg-status-info/15 text-status-info",
  reject:  "bg-status-danger/15 text-status-danger",
};

const FLAG_LABELS: Record<string, string> = {
  AE:      "AE",
  SDR:     "SDR",
  nurture: "Nurture",
  reject:  "Reject",
};

interface ScoreBadgeProps {
  routingFlag: string | null;
  fitScore: number | null;
}

export function ScoreBadge({ routingFlag, fitScore }: ScoreBadgeProps) {
  if (!routingFlag) {
    return (
      <span className="inline-flex items-center rounded-md border border-status-neutral/30 px-2 py-0.5 text-xs font-medium text-status-neutral">
        Unscored
      </span>
    );
  }

  const style = FLAG_STYLES[routingFlag] ?? "bg-status-neutral/15 text-status-neutral";
  const label = FLAG_LABELS[routingFlag] ?? routingFlag;
  const scoreText = fitScore != null ? ` \u00b7 ${fitScore.toFixed(2)}` : "";

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${style}`}
    >
      {label}{scoreText}
    </span>
  );
}
