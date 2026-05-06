import { cn } from "@/lib/utils";

type Status = "ready" | "error" | "pending";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

const config: Record<Status, { label: string; className: string }> = {
  ready: {
    label: "Ready",
    className:
      "bg-[oklch(0.20_0.06_145)] text-[oklch(0.65_0.18_145)] border border-[oklch(0.65_0.18_145_/_0.3)]",
  },
  error: {
    label: "Error",
    className:
      "bg-[oklch(0.18_0.06_25)] text-[oklch(0.62_0.22_25)] border border-[oklch(0.62_0.22_25_/_0.3)]",
  },
  pending: {
    label: "Pending",
    className:
      "bg-[oklch(0.20_0.05_75)] text-[oklch(0.72_0.14_75)] border border-[oklch(0.72_0.14_75_/_0.3)]",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, className: statusClass } = config[status] ?? config.pending;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase",
        statusClass,
        className
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", {
          "bg-[oklch(0.65_0.18_145)]": status === "ready",
          "bg-[oklch(0.62_0.22_25)]": status === "error",
          "bg-[oklch(0.72_0.14_75)]": status === "pending",
        })}
      />
      {label}
    </span>
  );
}
