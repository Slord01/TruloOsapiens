import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  RefreshCw,
  Search,
  Package,
  ChevronRight,
  AlertCircle,
  QrCode,
  Clock,
} from "lucide-react";

const PAGE_SIZE = 20;
type StatusFilter = "all" | "ready" | "error" | "pending";

export default function Orders() {
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { data, isLoading } = trpc.orders.list.useQuery({
    page,
    pageSize: PAGE_SIZE,
    status: statusFilter === "all" ? undefined : statusFilter,
    search: search || undefined,
  });

  const syncMutation = trpc.products.sync.useMutation({
    onSuccess: (result) => {
      toast.success(`Sync Products complete — ${result.count} tobacco products loaded`);
    },
    onError: (err) => {
      toast.error(`Sync failed: ${err.message}`);
    },
  });

  const cacheStats = trpc.products.cacheStats.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  const statusTabs: { label: string; value: StatusFilter }[] = [
    { label: "All", value: "all" },
    { label: "Ready", value: "ready" },
    { label: "Error", value: "error" },
    { label: "Pending", value: "pending" },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-primary/20 flex items-center justify-center">
              <QrCode className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground leading-tight">TNT Bridge</h1>
              <p className="text-xs text-muted-foreground">Xentral → Osapiens</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {cacheStats.data && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-card border border-border rounded-lg px-2.5 py-1.5">
                <Package className="h-3 w-3" />
                {cacheStats.data.count} products cached
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="gap-2 border-border text-foreground hover:bg-accent"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              Sync Products
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-5">
        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by order number or customer…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Button type="submit" variant="outline" className="border-border text-foreground hover:bg-accent">
            Search
          </Button>
        </form>

        {/* Status Tabs */}
        <div className="flex gap-1 p-1 bg-card rounded-xl border border-border w-fit">
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => { setStatusFilter(tab.value); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                statusFilter === tab.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {data && (
          <p className="text-xs text-muted-foreground">
            {data.total} order{data.total !== 1 ? "s" : ""}
          </p>
        )}

        {/* Order List */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[72px] rounded-xl bg-card animate-pulse border border-border" />
            ))}
          </div>
        ) : data?.notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="h-16 w-16 rounded-2xl bg-card border border-border flex items-center justify-center mb-4">
              <Package className="h-8 w-8 text-muted-foreground/40" />
            </div>
            <p className="font-medium text-foreground">No orders found</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Delivery notes containing tobacco products will appear here automatically
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {data?.notes.map((note) => (
              <button
                key={note.id}
                onClick={() => navigate(`/orders/${note.id}`)}
                className="w-full text-left rounded-xl border border-border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all duration-150 p-4 flex items-center gap-4 group"
              >
                <div
                  className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    note.status === "ready"
                      ? "bg-[oklch(0.20_0.06_145)]"
                      : note.status === "error"
                      ? "bg-[oklch(0.18_0.06_25)]"
                      : "bg-[oklch(0.20_0.05_75)]"
                  }`}
                >
                  {note.status === "ready" ? (
                    <QrCode className="h-5 w-5 text-[oklch(0.65_0.18_145)]" />
                  ) : note.status === "error" ? (
                    <AlertCircle className="h-5 w-5 text-[oklch(0.62_0.22_25)]" />
                  ) : (
                    <Clock className="h-5 w-5 text-[oklch(0.72_0.14_75)]" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground text-sm">
                      {note.xentralNumber || `#${note.id}`}
                    </span>
                    <StatusBadge status={note.status as "ready" | "error" | "pending"} />
                  </div>
                  <p className="text-sm text-muted-foreground truncate mt-0.5">
                    {note.customerName || "Unknown customer"}
                    {note.eoid && (
                      <span className="ml-2 text-xs opacity-60">EOID: {note.eoid}</span>
                    )}
                  </p>
                  {note.status === "error" && note.errorMessage && (
                    <p className="text-xs text-[oklch(0.62_0.22_25)] mt-0.5 truncate">
                      {note.errorMessage}
                    </p>
                  )}
                </div>

                <div className="flex-shrink-0 flex flex-col items-end gap-1">
                  {note.deliveryDate && (
                    <span className="text-xs text-muted-foreground">{note.deliveryDate}</span>
                  )}
                  <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="border-border text-foreground hover:bg-accent"
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground px-2">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="border-border text-foreground hover:bg-accent"
            >
              Next
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
