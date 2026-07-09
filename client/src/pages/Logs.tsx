import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  QrCode,
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type FilterValue = "all" | "success" | "failure";

const STEP_COLORS: Record<string, string> = {
  Organisation: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  DeliveryPoint: "bg-purple-500/15 text-purple-400 border border-purple-500/30",
  SalesOrder: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
};

function StepBadge({ step }: { step: string }) {
  const cls = STEP_COLORS[step] ?? "bg-muted text-muted-foreground border border-border";
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}>
      {step}
    </span>
  );
}

function SuccessBadge({ success }: { success: boolean }) {
  return success ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      OK
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-400">
      <XCircle className="h-3.5 w-3.5" />
      Fail
    </span>
  );
}

function ExpandableCell({ content }: { content: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!content) return <span className="text-muted-foreground text-xs">—</span>;

  const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;

  return (
    <div className="max-w-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        )}
        <span className={expanded ? "whitespace-pre-wrap break-all font-mono" : ""}>
          {expanded ? content : preview}
        </span>
      </button>
    </div>
  );
}

export default function Logs() {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<FilterValue>("all");

  const { data, isLoading, refetch, isFetching } = trpc.logs.list.useQuery(
    { limit: 200, offset: 0, filter },
    { refetchInterval: 30_000 }
  );

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/")}
              className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline text-xs">Orders</span>
            </Button>
            <div className="h-9 w-9 rounded-xl bg-primary/20 flex items-center justify-center">
              <QrCode className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground leading-tight">Osapiens Logs</h1>
              <p className="text-xs text-muted-foreground">API call history</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Select value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
              <SelectTrigger className="h-8 w-32 text-xs bg-card border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All calls</SelectItem>
                <SelectItem value="success">Success only</SelectItem>
                <SelectItem value="failure">Failures only</SelectItem>
              </SelectContent>
            </Select>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              <span className="hidden md:inline text-xs">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="container py-6">
        {/* Summary row */}
        <div className="flex items-center gap-4 mb-4 text-sm text-muted-foreground">
          <span>
            {isLoading ? "Loading…" : `${total} log entr${total !== 1 ? "ies" : "y"} total`}
          </span>
          {!isLoading && total > 200 && (
            <span className="text-xs text-amber-400">Showing latest 200</span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            Loading logs…
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
            <QrCode className="h-10 w-10 opacity-30" />
            <p className="text-sm">No log entries yet.</p>
            <p className="text-xs">Logs appear here after you send an order to Osapiens.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-card/60 hover:bg-card/60">
                  <TableHead className="text-xs w-40">Timestamp</TableHead>
                  <TableHead className="text-xs w-28">Order #</TableHead>
                  <TableHead className="text-xs">Customer</TableHead>
                  <TableHead className="text-xs w-32">Step</TableHead>
                  <TableHead className="text-xs w-16">HTTP</TableHead>
                  <TableHead className="text-xs w-16">Status</TableHead>
                  <TableHead className="text-xs">Response</TableHead>
                  <TableHead className="text-xs">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow
                    key={log.id}
                    className={`text-xs ${!log.success ? "bg-red-500/5 hover:bg-red-500/10" : "hover:bg-accent/30"}`}
                  >
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono font-medium text-foreground">
                      {log.xentralNumber}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[160px] truncate">
                      {log.customerName ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StepBadge step={log.step} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.httpStatus ?? "—"}
                    </TableCell>
                    <TableCell>
                      <SuccessBadge success={log.success} />
                    </TableCell>
                    <TableCell>
                      <ExpandableCell content={log.responseBody} />
                    </TableCell>
                    <TableCell>
                      <ExpandableCell content={log.errorMessage} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  );
}
