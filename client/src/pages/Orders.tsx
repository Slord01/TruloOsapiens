import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  RefreshCw,
  Search,
  Package,
  ChevronRight,
  AlertCircle,
  QrCode,
  Clock,
  Download,
  Database,
  Trash2,
  Send,
  CheckCircle2,
  ScrollText,
} from "lucide-react";

const PAGE_SIZE = 20;
type StatusFilter = "all" | "ready" | "sent" | "error" | "pending";

export default function Orders() {
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [lookbackDays] = useState(7);
  const [docNumberInput, setDocNumberInput] = useState("");
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.orders.list.useQuery({
    page,
    pageSize: PAGE_SIZE,
    status: statusFilter === "all" ? undefined : statusFilter,
    search: search || undefined,
  });

  // Fetch a single delivery note by document number
  const fetchByDocMutation = trpc.orders.fetchByDocumentNumber.useMutation({
    onSuccess: (result) => {
      utils.orders.list.invalidate();
      setDocNumberInput("");
      if (result.fetched === 0) {
        toast.error(`No delivery note found with that document number`);
      } else if (result.errors > 0) {
        toast.warning(`Fetched — check order for errors`);
      } else {
        toast.success(`Order fetched successfully`);
      }
    },
    onError: (err) => {
      toast.error(`Fetch failed: ${err.message}`);
    },
  });

  // Primary action: fetch delivery notes from Xentral API
  const fetchMutation = trpc.orders.fetchFromXentral.useMutation({
    onSuccess: (result) => {
      utils.orders.list.invalidate();
      if (result.fetched === 0) {
        toast.info(`No delivery notes found in the last ${lookbackDays} days`);
      } else {
        const tobaccoCount = result.tobaccoFound ?? 0;
        const readyCount = result.imported;
        const errorCount = result.errors;
        const skippedCount = result.skipped;
        if (tobaccoCount === 0) {
          toast.info(`Scanned ${result.fetched} delivery note${result.fetched !== 1 ? "s" : ""} — no tobacco orders found`);
        } else if (readyCount > 0 && errorCount === 0) {
          toast.success(
            `${tobaccoCount} tobacco order${tobaccoCount !== 1 ? "s" : ""} found — ${readyCount} ready${skippedCount > 0 ? `, ${skippedCount} already processed` : ""}`
          );
        } else if (readyCount > 0 && errorCount > 0) {
          toast.warning(
            `${tobaccoCount} tobacco order${tobaccoCount !== 1 ? "s" : ""} — ${readyCount} ready, ${errorCount} with errors`
          );
        } else {
          toast.error(
            `${tobaccoCount} tobacco order${tobaccoCount !== 1 ? "s" : ""} — ${errorCount} error${errorCount !== 1 ? "s" : ""} (check order details)`
          );
        }
      }
    },
    onError: (err) => {
      toast.error(`Fetch failed: ${err.message}`);
    },
  });

  // Secondary action: refresh tobacco product cache
  const syncMutation = trpc.products.sync.useMutation({
    onSuccess: (result) => {
      toast.success(`Product cache refreshed — ${result.count} tobacco products loaded`);
    },
    onError: (err) => {
      toast.error(`Product sync failed: ${err.message}`);
    },
  });

  // Delete a single order
  const deleteMutation = trpc.orders.delete.useMutation({
    onSuccess: () => {
      utils.orders.list.invalidate();
      toast.success("Order removed");
    },
    onError: (err) => toast.error(`Delete failed: ${err.message}`),
  });

  // Bulk delete all error orders
  const bulkDeleteMutation = trpc.orders.bulkDelete.useMutation({
    onSuccess: (result) => {
      utils.orders.list.invalidate();
      toast.success(`Removed ${result.deleted} error order${result.deleted !== 1 ? "s" : ""}`);
    },
    onError: (err) => {
      toast.error(`Bulk delete failed: ${err.message}`);
    },
  });

  // Send a single order to Osapiens
  const sendToOsapiensMutation = trpc.orders.sendToOsapiens.useMutation({
    onSuccess: (data) => {
      utils.orders.list.invalidate();
      toast.success(data.qrRefreshed ? `${data.message} QR code refreshed.` : data.message);
    },
    onError: (err) => {
      toast.error(`Send to Osapiens failed: ${err.message}`);
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
    { label: "Sent", value: "sent" },
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
              <p className="text-xs text-muted-foreground">Xentral &rarr; Osapiens</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Logs nav link */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate("/logs")}
              className="gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
              title="View Osapiens API call logs"
            >
              <ScrollText className="h-3.5 w-3.5" />
              <span className="hidden md:inline text-xs">Logs</span>
            </Button>

            {/* Product cache indicator */}
            {cacheStats.data && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-card border border-border rounded-lg px-2.5 py-1.5">
                <Database className="h-3 w-3" />
                {cacheStats.data.count} products cached
              </span>
            )}

            {/* Secondary: Sync Products (refresh tobacco product cache only) */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              title="Refresh tobacco product cache (Category 95000)"
              className="gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              <span className="hidden md:inline text-xs">Sync Products</span>
            </Button>

            {/* Document number quick-fetch input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (docNumberInput.trim()) {
                  fetchByDocMutation.mutate({ documentNumber: docNumberInput.trim() });
                }
              }}
              className="hidden md:flex items-center gap-1.5"
            >
              <Input
                placeholder="Doc number…"
                value={docNumberInput}
                onChange={(e) => setDocNumberInput(e.target.value)}
                className="h-8 w-36 text-xs bg-card border-border text-foreground placeholder:text-muted-foreground"
                disabled={fetchByDocMutation.isPending}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={!docNumberInput.trim() || fetchByDocMutation.isPending}
                className="h-8 px-2 border-border text-foreground hover:bg-accent"
                title="Fetch this specific delivery note from Xentral"
              >
                {fetchByDocMutation.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </Button>
            </form>

            {/* Primary: Fetch Orders from Xentral */}
            <Button
              size="sm"
              onClick={() => fetchMutation.mutate({ lookbackDays })}
              disabled={fetchMutation.isPending}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Download className={`h-3.5 w-3.5 ${fetchMutation.isPending ? "animate-bounce" : ""}`} />
              {fetchMutation.isPending ? "Fetching…" : "Fetch Orders"}
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
              placeholder="Search by order number or customer\u2026"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Button type="submit" variant="outline" className="border-border text-foreground hover:bg-accent">
            Search
          </Button>
        </form>

        {/* Status Tabs + count + bulk actions */}
        <div className="flex items-center justify-between flex-wrap gap-3">
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

          <div className="flex items-center gap-2">
            {data && (
              <p className="text-xs text-muted-foreground">
                {data.total} order{data.total !== 1 ? "s" : ""}
              </p>
            )}
            {/* Bulk clear — only shown on Error tab when there are error orders */}
            {statusFilter === "error" && data && data.total > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-[oklch(0.62_0.22_25)] hover:bg-[oklch(0.18_0.06_25)] gap-1"
                    disabled={bulkDeleteMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3" />
                    {bulkDeleteMutation.isPending ? "Deleting…" : "Clear all errors"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear all error orders?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove all {data.total} error order{data.total !== 1 ? "s" : ""} from the database.
                      Orders that are missing EOID or have other mapping errors will be deleted.
                      This action cannot be undone — you can re-fetch them from Xentral at any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => bulkDeleteMutation.mutate({ status: "error" })}
                    >
                      Delete {data.total} order{data.total !== 1 ? "s" : ""}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

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
              Click <strong className="text-foreground">Fetch Orders</strong> to pull recent delivery notes from Xentral,
              or configure a webhook in Xentral to push them automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {data?.notes.map((note) => (
              <div
                key={note.id}
                className="relative rounded-xl border border-border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all duration-150 group"
              >
                {/* Clickable row navigates to detail */}
                <button
                  onClick={() => navigate(`/orders/${note.id}`)}
                  className="w-full text-left p-4 flex items-center gap-4 pr-10"
                >
                  <div
                    className={`h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      note.status === "ready" || note.status === "sent"
                        ? "bg-[oklch(0.20_0.06_145)]"
                        : note.status === "error"
                        ? "bg-[oklch(0.18_0.06_25)]"
                        : "bg-[oklch(0.20_0.05_75)]"
                    }`}
                  >
                    {note.status === "ready" ? (
                      <QrCode className="h-5 w-5 text-[oklch(0.65_0.18_145)]" />
                    ) : note.status === "sent" ? (
                      <CheckCircle2 className="h-5 w-5 text-[oklch(0.72_0.18_145)]" />
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
                      <StatusBadge status={note.status as "ready" | "sent" | "error" | "pending"} />
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

                {/* Per-row action buttons — appear on hover */}
                <div className="absolute top-1/2 -translate-y-1/2 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {/* Send to Osapiens — only shown for READY orders. Sent orders can be
                      re-synchronised from their detail page without leaving this state. */}
                  {note.status === "ready" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        sendToOsapiensMutation.mutate({ id: note.id });
                      }}
                      disabled={sendToOsapiensMutation.isPending && sendToOsapiensMutation.variables?.id === note.id}
                      className="h-7 w-7 rounded-lg flex items-center justify-center transition-colors text-muted-foreground hover:text-[oklch(0.65_0.18_145)] hover:bg-[oklch(0.20_0.06_145)]"
                      title="Send SalesOrder to Osapiens"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate({ id: note.id });
                    }}
                    disabled={deleteMutation.isPending && deleteMutation.variables?.id === note.id}
                    className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-[oklch(0.62_0.22_25)] hover:bg-[oklch(0.18_0.06_25)]"
                    title="Remove this order"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
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
