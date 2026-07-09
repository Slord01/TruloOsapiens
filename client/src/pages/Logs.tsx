import { useState, useEffect, useRef } from "react";
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
  QrCode,
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  Info,
  Terminal,
  Trash2,
} from "lucide-react";

type LevelFilter = "all" | "log" | "warn" | "error" | "info";

const LEVEL_STYLES: Record<string, string> = {
  error: "text-red-400",
  warn:  "text-amber-400",
  info:  "text-blue-400",
  log:   "text-muted-foreground",
};

const LEVEL_BADGE: Record<string, string> = {
  error: "bg-red-500/15 text-red-400 border border-red-500/30",
  warn:  "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  info:  "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  log:   "bg-muted/40 text-muted-foreground border border-border",
};

function LevelBadge({ level }: { level: string }) {
  const cls = LEVEL_BADGE[level] ?? LEVEL_BADGE.log;
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase shrink-0 ${cls}`}>
      {level}
    </span>
  );
}

export default function Logs() {
  const [, navigate] = useLocation();
  const [level, setLevel] = useState<LevelFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [cleared, setCleared] = useState(0); // bump to visually "clear" the view
  const [clearedBefore, setClearedBefore] = useState<number | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Poll every 2 seconds for new entries
  const { data, isLoading, isFetching, refetch } = trpc.logs.getLive.useQuery(
    { level, limit: 500 },
    { refetchInterval: 2000 }
  );

  const entries = (data?.entries ?? []).filter(
    (e) => clearedBefore == null || e.id > clearedBefore
  );

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, autoScroll]);

  function handleClear() {
    const lastId = data?.lastId ?? 0;
    setClearedBefore(lastId);
    setCleared((n) => n + 1);
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
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
              <Terminal className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground leading-tight">Server Logs</h1>
              <p className="text-xs text-muted-foreground">Live backend console output</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Level filter */}
            <Select value={level} onValueChange={(v) => setLevel(v as LevelFilter)}>
              <SelectTrigger className="h-8 w-28 text-xs bg-card border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                <SelectItem value="error">Errors</SelectItem>
                <SelectItem value="warn">Warnings</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="log">Log</SelectItem>
              </SelectContent>
            </Select>

            {/* Auto-scroll toggle */}
            <Button
              size="sm"
              variant={autoScroll ? "default" : "outline"}
              onClick={() => setAutoScroll((v) => !v)}
              className="h-8 px-2.5 text-xs gap-1.5"
              title="Toggle auto-scroll to bottom"
            >
              <ArrowLeft className={`h-3.5 w-3.5 rotate-[-90deg] transition-transform ${autoScroll ? "" : "opacity-40"}`} />
              <span className="hidden md:inline">Auto-scroll</span>
            </Button>

            {/* Clear view */}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleClear}
              className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
              title="Clear the current view (does not delete logs)"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden md:inline">Clear</span>
            </Button>

            {/* Manual refresh */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              <span className="hidden md:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Log terminal */}
      <main className="container py-4 flex-1 flex flex-col">
        {/* Stats bar */}
        <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            Live · polling every 2s
          </span>
          <span>{entries.length} entr{entries.length !== 1 ? "ies" : "y"} shown</span>
          {entries.filter((e) => e.level === "error").length > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertTriangle className="h-3 w-3" />
              {entries.filter((e) => e.level === "error").length} error{entries.filter((e) => e.level === "error").length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="flex-1 rounded-xl border border-border bg-black/40 font-mono text-xs overflow-auto max-h-[calc(100vh-180px)]">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Connecting to log stream…
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <Info className="h-8 w-8 opacity-30" />
              <p>No log entries yet.</p>
              <p className="text-[11px]">Server output will appear here as actions are performed.</p>
            </div>
          ) : (
            <div className="p-3 space-y-0.5">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex items-start gap-2 py-0.5 hover:bg-white/5 rounded px-1 ${LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.log}`}
                >
                  {/* Timestamp */}
                  <span className="text-[10px] text-muted-foreground/60 shrink-0 pt-0.5 w-[155px]">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                    <span className="text-[9px] ml-1 opacity-50">
                      .{new Date(entry.ts).getMilliseconds().toString().padStart(3, "0")}
                    </span>
                  </span>
                  {/* Level badge */}
                  <LevelBadge level={entry.level} />
                  {/* Message */}
                  <span className="flex-1 break-all whitespace-pre-wrap leading-relaxed">
                    {entry.message}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
