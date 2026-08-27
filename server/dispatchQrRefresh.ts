import { getDb, getDeliveryNoteById } from "./db";
import { deliveryNotes } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { generateDispatchQrCode } from "./qrGenerator";

/**
 * Regenerates a delivery note's stored QR code from the current database fields.
 * The refresh is intentionally run after an Osapiens sync so older orders adopt
 * the specification-compliant REF_DOC, destination FID, empty custom fields,
 * and correct product count without a separate Xentral fetch.
 */
export async function refreshDispatchQrForOrder(id: number): Promise<void> {
  const note = await getDeliveryNoteById(id);
  if (!note) throw new Error(`Delivery note ${id} not found while refreshing its QR code`);
  if (!note.fid) throw new Error("Customer FID is missing while refreshing the QR code");

  const products = note.items
    .map((item) => ({
      gtin: item.ean || item.productNumber || "",
      quantity: Math.round(Number(item.quantity ?? 0)),
    }))
    .filter((product) => product.gtin.length > 0);

  const qr = await generateDispatchQrCode({
    referenceDocument: note.xentralNumber,
    fid: note.fid,
    eventTime: new Date(),
    destinationType: 2,
    transportMode: 3,
    transportVehicle: "",
    products,
  });

  const db = await getDb();
  if (!db) throw new Error("Database unavailable while refreshing the QR code");
  await db.update(deliveryNotes).set({
    qrCodeDataUrl: qr.dataUrl,
    dispatchQrText: qr.plainText,
  }).where(eq(deliveryNotes.id, id));
}
