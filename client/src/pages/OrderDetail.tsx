import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { StatusBadge } from "@/components/StatusBadge";
import { getDisplayOrderStatus } from "@shared/orderStatus";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  User,
  MapPin,
  Package,
  Hash,
  Calendar,
  QrCode,
  Download,
  CreditCard,
  Truck,
  Send,
  CheckCircle2,
} from "lucide-react";

interface OrderDetailProps {
  id: string;
}

function DataRow({ label, value, highlight }: { label: string; value?: string | null; highlight?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide flex-shrink-0 w-36">
        {label}
      </span>
      <span
        className={`text-sm text-right break-all ${
          highlight ? "text-primary font-semibold" : value ? "text-foreground" : "text-muted-foreground/50 italic"
        }`}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-card/80">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

export default function OrderDetail({ id }: OrderDetailProps) {
  const [, navigate] = useLocation();
  const numId = parseInt(id, 10);

  const { data: note, isLoading, refetch } = trpc.orders.getById.useQuery(
    { id: numId },
    { enabled: !isNaN(numId) }
  );

  const utils = trpc.useUtils();

  const sendToOsapiensMutation = trpc.orders.sendToOsapiens.useMutation({
    onSuccess: (data) => {
      toast.success(data.qrRefreshed ? `${data.message} QR code refreshed.` : data.message);
      refetch();
    },
    onError: (err) => {
      toast.error(`Send to Osapiens failed: ${err.message}`);
      refetch(); // Refresh to show the error message
    },
  });

  const retryMutation = trpc.orders.retry.useMutation({
    onSuccess: (result) => {
      toast.success(`Re-fetch complete — status: ${result.status}`);
      refetch();
    },
    onError: (err) => {
      toast.error(`Retry failed: ${err.message}`);
    },
  });

  const handleDownloadQr = () => {
    if (!note?.qrCodeDataUrl) return;
    const a = document.createElement("a");
    a.href = note.qrCodeDataUrl;
    a.download = `QR-${note.xentralNumber || note.id}.png`;
    a.click();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card/60 sticky top-0 z-10">
          <div className="container py-4">
            <div className="h-8 w-48 bg-card animate-pulse rounded-lg" />
          </div>
        </header>
        <main className="container py-6">
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="h-80 bg-card animate-pulse rounded-xl border border-border" />
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-32 bg-card animate-pulse rounded-xl border border-border" />
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!note) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Order not found</p>
          <Button variant="outline" onClick={() => navigate("/")} className="mt-4 border-border text-foreground">
            Back to Orders
          </Button>
        </div>
      </div>
    );
  }

  const status = getDisplayOrderStatus(note.status, note.sentToOsapiens);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container py-4 flex items-center gap-4">
          <button
            onClick={() => navigate("/")}
            className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-base font-semibold text-foreground truncate">
                {note.xentralNumber || `Order #${note.id}`}
              </h1>
              <StatusBadge status={status} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {note.customerName || "Unknown customer"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {status === "error" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => retryMutation.mutate({ id: numId })}
                disabled={retryMutation.isPending}
                className="gap-2 border-border text-foreground hover:bg-accent"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${retryMutation.isPending ? "animate-spin" : ""}`} />
                Retry / Re-fetch
              </Button>
            )}
            {status === "ready" && (
              <Button
                size="sm"
                variant={note.sentToOsapiens ? "outline" : "default"}
                onClick={() => sendToOsapiensMutation.mutate({ id: numId })}
                disabled={sendToOsapiensMutation.isPending}
                className={`gap-2 ${
                  note.sentToOsapiens
                    ? "border-[oklch(0.65_0.18_145)] text-[oklch(0.65_0.18_145)] hover:bg-[oklch(0.20_0.06_145)]"
                    : ""
                }`}
              >
                {sendToOsapiensMutation.isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : note.sentToOsapiens ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {note.sentToOsapiens ? "Resend to Osapiens" : "Send to Osapiens"}
              </Button>
            )}
            {status === "sent" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendToOsapiensMutation.mutate({ id: numId })}
                disabled={sendToOsapiensMutation.isPending}
                className="gap-2 border-[oklch(0.65_0.18_145)] text-[oklch(0.72_0.18_145)] hover:bg-[oklch(0.20_0.06_145)]"
                title="Recheck the SalesOrder and synchronise its customer master data"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${sendToOsapiensMutation.isPending ? "animate-spin" : ""}`} />
                Sync Osapiens data
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container py-6">
        <div className="grid lg:grid-cols-2 gap-6">
          {/* ── Left: QR Code ── */}
          <div className="space-y-4">
            {(status === "ready" || status === "sent") && note.qrCodeDataUrl ? (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/80">
                  <div className="flex items-center gap-2.5">
                    <QrCode className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">Osapiens QR Code</h3>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleDownloadQr}
                    className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="text-xs">Download</span>
                  </Button>
                </div>
                <div className="p-6 flex items-center justify-center bg-white rounded-b-xl">
                  <img
                    src={note.qrCodeDataUrl}
                    alt={`QR code for order ${note.xentralNumber}`}
                    className="w-full max-w-[320px] h-auto"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
                <div className="px-4 py-3 border-t border-border bg-[oklch(0.20_0.06_145_/_0.3)]">
                  <p className="text-xs text-[oklch(0.65_0.18_145)] text-center font-medium">
                    Scan this code with the Osapiens scanner to load dispatch data
                  </p>
                  {note.dispatchQrText && (
                    <p className="text-[10px] text-muted-foreground text-center mt-1.5 break-all font-mono leading-relaxed">
                      {note.dispatchQrText}
                    </p>
                  )}
                </div>
              </div>
            ) : status === "error" ? (
              <div className="rounded-xl border border-[oklch(0.62_0.22_25_/_0.4)] bg-[oklch(0.18_0.06_25_/_0.5)] p-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-[oklch(0.62_0.22_25)] flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-[oklch(0.62_0.22_25)] mb-1">
                      QR Code cannot be generated
                    </p>
                    <p className="text-sm text-foreground/80 leading-relaxed">
                      {note.errorMessage || "An error occurred during processing."}
                    </p>
                    <p className="text-xs text-muted-foreground mt-3">
                      Fix the issue in Xentral, then click{" "}
                      <span className="font-semibold text-foreground">Retry / Re-fetch</span> to regenerate.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-6 flex items-center justify-center min-h-[200px]">
                <div className="text-center">
                  <div className="h-12 w-12 rounded-xl bg-[oklch(0.20_0.05_75)] flex items-center justify-center mx-auto mb-3">
                    <QrCode className="h-6 w-6 text-[oklch(0.72_0.14_75)]" />
                  </div>
                  <p className="text-sm text-muted-foreground">Processing…</p>
                </div>
              </div>
            )}

            {/* Delivery date */}
            {note.deliveryDate && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
                <Calendar className="h-4 w-4" />
                Delivery date: <span className="text-foreground font-medium">{note.deliveryDate}</span>
              </div>
            )}
          </div>

          {/* ── Right: Data Verification Panel ── */}
          <div className="space-y-4">
            {/* Order Info */}
            <Section title="Order Information" icon={Hash}>
              <DataRow label="Delivery Note" value={note.xentralNumber} highlight />
              {(note as {salesOrderNumber?: string | null}).salesOrderNumber && (
                <DataRow label="Sales Order" value={(note as {salesOrderNumber?: string | null}).salesOrderNumber} />
              )}
              <DataRow label="Delivery Date" value={note.deliveryDate} />
            </Section>

            {/* Order Value & Payment */}
            {((note as {paymentMethod?: string | null}).paymentMethod ||
              (note as {deliveryMethod?: string | null}).deliveryMethod ||
              (note as {orderValue?: string | null}).orderValue) && (
              <Section title="Order Details" icon={CreditCard}>
                {(note as {orderValue?: string | null}).orderValue && (
                  <DataRow
                    label="Order Value"
                    value={`${Number((note as {orderValue?: string | null}).orderValue).toFixed(2)} ${
                      (note as {orderCurrency?: string | null}).orderCurrency ?? "EUR"
                    }`}
                    highlight
                  />
                )}
                {(note as {paymentMethod?: string | null}).paymentMethod && (
                  <DataRow label="Payment Method" value={(note as {paymentMethod?: string | null}).paymentMethod} />
                )}
                {(note as {deliveryMethod?: string | null}).deliveryMethod && (
                  <DataRow label="Delivery Method" value={(note as {deliveryMethod?: string | null}).deliveryMethod} />
                )}
              </Section>
            )}

            {/* Customer */}
            <Section title="Customer" icon={User}>
              <DataRow label="Name" value={note.customerName} />
              <DataRow label="EOID Number" value={note.eoid} highlight />
              <DataRow label="FID" value={(note as {fid?: string | null}).fid} highlight />
            </Section>

            {/* Address */}
            <Section title="Delivery Address" icon={MapPin}>
              <DataRow label="Street" value={note.addressStreet} />
              <DataRow label="City" value={note.addressCity} />
              <DataRow label="Postal Code" value={note.addressPostalCode} />
              <DataRow label="Country" value={note.addressCountry} />
            </Section>

            {/* Products */}
            {note.items && note.items.length > 0 && (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-card/80">
                  <Package className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold text-foreground">
                    Tobacco Products ({note.items.length})
                  </h3>
                </div>
                <div className="divide-y divide-border/50">
                  {note.items.map((item, idx) => (
                    <div key={idx} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {item.productName || item.productNumber || `Product ${idx + 1}`}
                          </p>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            {item.productNumber && (
                              <span className="text-xs text-muted-foreground">
                                SKU: <span className="text-foreground">{item.productNumber}</span>
                              </span>
                            )}
                            {item.ean && (
                              <span className="text-xs text-muted-foreground">
                                GTIN: <span className="text-foreground font-medium">{item.ean}</span>
                              </span>
                            )}
                            {!item.ean && item.productNumber && (
                              <span className="text-xs text-[oklch(0.65_0.18_45)] bg-[oklch(0.20_0.06_45_/_0.3)] px-1.5 py-0.5 rounded">
                                No GTIN — using SKU in QR
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-semibold text-foreground">
                            {item.quantity} {item.unit}
                          </p>
                          {item.unitPrice && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {Number(item.unitPrice).toFixed(2)} {item.currency ?? "EUR"}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Osapiens Send Status ── */}
        {(status === "ready" || status === "sent") && (
          <div className="mt-4">
            {(note as {sentToOsapiens?: boolean | null}).sentToOsapiens ? (
              <div className="rounded-xl border border-[oklch(0.65_0.18_145_/_0.4)] bg-[oklch(0.20_0.06_145_/_0.3)] px-4 py-3 flex items-center gap-3">
                <CheckCircle2 className="h-4 w-4 text-[oklch(0.65_0.18_145)] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[oklch(0.65_0.18_145)]">
                    SalesOrder sent to Osapiens
                  </p>
                  {(note as {sentToOsapiensAt?: number | null}).sentToOsapiensAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Sent {new Date((note as {sentToOsapiensAt: number}).sentToOsapiensAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => sendToOsapiensMutation.mutate({ id: numId })}
                  disabled={sendToOsapiensMutation.isPending}
                  className="text-muted-foreground hover:text-foreground text-xs h-7 px-2 flex-shrink-0"
                >
                  {sendToOsapiensMutation.isPending ? (
                    <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Send className="h-3 w-3 mr-1" />
                  )}
                  Sync data
                </Button>
              </div>
            ) : (note as {osapiensSendError?: string | null}).osapiensSendError ? (
              <div className="rounded-xl border border-[oklch(0.62_0.22_25_/_0.4)] bg-[oklch(0.18_0.06_25_/_0.3)] px-4 py-3 flex items-start gap-3">
                <AlertCircle className="h-4 w-4 text-[oklch(0.62_0.22_25)] flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[oklch(0.62_0.22_25)]">
                    Failed to send to Osapiens
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 break-words">
                    {(note as {osapiensSendError: string}).osapiensSendError}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => sendToOsapiensMutation.mutate({ id: numId })}
                  disabled={sendToOsapiensMutation.isPending}
                  className="text-muted-foreground hover:text-foreground text-xs h-7 px-2 flex-shrink-0"
                >
                  {sendToOsapiensMutation.isPending ? (
                    <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
