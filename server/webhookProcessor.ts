/**
 * Processes an incoming Xentral deliveryNote.created webhook payload.
 * 1. Normalises the payload
 * 2. Filters positions to tobacco-only (Category 95000 via product cache)
 * 3. Maps to Osapiens SalesOrder
 * 4. Generates QR code
 * 5. Persists to database
 */
import {
  isTobaccoProduct,
  isTobaccoProductNumber,
  refreshProductCache,
  getCacheStats,
  type CachedProduct,
  getCachedProduct,
} from "./productCache";
import {
  mapDeliveryNoteToSalesOrder,
  type XentralDeliveryNotePayload,
  type XentralPosition,
} from "./dataMapper";
import { generateQrCode } from "./qrGenerator";
import {
  upsertDeliveryNote,
  insertDeliveryNoteItems,
  deleteDeliveryNoteItems,
  getDeliveryNoteByXentralId,
  updateDeliveryNoteStatus,
} from "./db";

async function ensureCacheLoaded() {
  const stats = getCacheStats();
  if (!stats.lastRefreshed) {
    await refreshProductCache();
  }
}

/**
 * Filter delivery note positions to tobacco-only items.
 * If a position's product ID is in the cache, it's tobacco.
 * If the cache is empty (no Xentral credentials), all positions pass through.
 */
function filterTobaccoPositions(positions: XentralPosition[]): XentralPosition[] {
  return positions.filter((pos) => {
    // Primary check: product number (SKU) starts with "95" — works without cache
    const productNumber = String(pos.product?.number ?? "");
    if (productNumber && isTobaccoProductNumber(productNumber)) return true;
    // Secondary check: product ID is in the Category 95000 cache
    const productId = String(pos.product?.id ?? "");
    if (productId && isTobaccoProduct(productId)) return true;
    return false;
  });
}

/**
 * Enrich position data with cached product details (EAN, canonical name).
 */
function enrichPositions(positions: XentralPosition[]): XentralPosition[] {
  return positions.map((pos) => {
    const productId = String(pos.product?.id ?? "");
    const cached: CachedProduct | undefined = productId ? getCachedProduct(productId) : undefined;
    if (!cached) return pos;
    return {
      ...pos,
      product: {
        ...pos.product,
        ean: pos.product?.ean ?? cached.ean,
        number: pos.product?.number ?? cached.number,
        name: pos.product?.name ?? cached.name,
      },
    };
  });
}

export async function processWebhookPayload(raw: unknown): Promise<{ id: number; status: string }> {
  await ensureCacheLoaded();

  const payload = raw as XentralDeliveryNotePayload;
  const xentralId = String(payload.id ?? payload.deliveryNoteId ?? "");
  const xentralNumber = String(payload.documentNumber ?? payload.number ?? payload.deliveryNoteNumber ?? xentralId);
  const deliveryDate = String(payload.date ?? new Date().toISOString().split("T")[0]);
  const salesOrderNumber = payload.salesOrderNumber ? String(payload.salesOrderNumber) : undefined;

  // Upsert a pending record first so we always have a DB row
  const baseNote = await upsertDeliveryNote({
    xentralId,
    xentralNumber,
    salesOrderNumber,
    deliveryDate,
    rawPayload: raw as Record<string, unknown>,
    status: "pending",
    customerId: String(payload.customer?.id ?? payload.customerData?.id ?? ""),
    customerName:
      payload.customer?.companyName ??
      payload.customer?.name ??
      payload.customerData?.companyName ??
      payload.customerData?.name ??
      "",
  });

  if (!baseNote) throw new Error("Failed to upsert delivery note");

  const allPositions: XentralPosition[] = payload.positions ?? payload.items ?? [];
  const tobaccoPositions = enrichPositions(filterTobaccoPositions(allPositions));

  // Map to Osapiens SalesOrder
  const mapping = mapDeliveryNoteToSalesOrder(payload, tobaccoPositions);

  if (!mapping.success) {
    await updateDeliveryNoteStatus(baseNote.id, {
      status: "error",
      errorMessage: mapping.errorMessage ?? "Mapping failed",
      eoid: mapping.eoid ?? null,
      customerName: mapping.customerName ?? null,
      addressStreet: mapping.addressStreet ?? null,
      addressCity: mapping.addressCity ?? null,
      addressPostalCode: mapping.addressPostalCode ?? null,
      addressCountry: mapping.addressCountry ?? null,
    });

    // Persist items even on error for display
    await deleteDeliveryNoteItems(baseNote.id);
    if (tobaccoPositions.length > 0) {
      await insertDeliveryNoteItems(
        tobaccoPositions.map((pos) => ({
          deliveryNoteId: baseNote.id,
          productId: String(pos.product?.id ?? ""),
          productNumber: String(pos.product?.number ?? ""),
          productName: String(pos.product?.name ?? ""),
          ean: pos.product?.ean ?? null,
          quantity: String(pos.quantity ?? "0"),
          unit: String(pos.unit ?? "PCE"),
          unitPrice: pos.price?.amount !== undefined ? String(pos.price.amount) : null,
          currency: pos.price?.currency ?? "EUR",
        }))
      );
    }

    return { id: baseNote.id, status: "error" };
  }

  // Generate QR code
  let qrCodeDataUrl: string | null = null;
  try {
    qrCodeDataUrl = await generateQrCode(mapping.salesOrder!);
  } catch (err) {
    console.error("[QR] Failed to generate QR code:", err);
  }

  await updateDeliveryNoteStatus(baseNote.id, {
    status: qrCodeDataUrl ? "ready" : "error",
    osapiensSalesOrder: mapping.salesOrder as unknown as Record<string, unknown>,
    qrCodeDataUrl,
    errorMessage: qrCodeDataUrl ? null : "QR code generation failed",
    eoid: mapping.eoid ?? null,
    customerName: mapping.customerName ?? null,
    addressStreet: mapping.addressStreet ?? null,
    addressCity: mapping.addressCity ?? null,
    addressPostalCode: mapping.addressPostalCode ?? null,
    addressCountry: mapping.addressCountry ?? null,
  });

  // Persist items
  await deleteDeliveryNoteItems(baseNote.id);
  await insertDeliveryNoteItems(
    tobaccoPositions.map((pos) => ({
      deliveryNoteId: baseNote.id,
      productId: String(pos.product?.id ?? ""),
      productNumber: String(pos.product?.number ?? ""),
      productName: String(pos.product?.name ?? ""),
      ean: pos.product?.ean ?? null,
      quantity: String(pos.quantity ?? "0"),
      unit: String(pos.unit ?? "PCE"),
      unitPrice: pos.price?.amount !== undefined ? String(pos.price.amount) : null,
      currency: pos.price?.currency ?? "EUR",
    }))
  );

  return { id: baseNote.id, status: qrCodeDataUrl ? "ready" : "error" };
}

/**
 * Re-process an existing delivery note (Retry / Re-fetch).
 * Re-runs the full mapping + QR generation pipeline using the stored raw payload.
 */
export async function retryDeliveryNote(id: number): Promise<{ status: string }> {
  const { getDeliveryNoteById } = await import("./db");
  const note = await getDeliveryNoteById(id);
  if (!note) throw new Error("Delivery note not found");
  if (!note.rawPayload) throw new Error("No raw payload stored for this delivery note");

  await refreshProductCache();
  const result = await processWebhookPayload(note.rawPayload);
  return { status: result.status };
}
