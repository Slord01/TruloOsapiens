/**
 * QR code generator for Osapiens SalesOrder JSON payloads.
 * Produces a base64-encoded PNG data URL suitable for embedding in HTML.
 */
import QRCode from "qrcode";
import type { OsapiensSalesOrder } from "./dataMapper";

const QR_OPTIONS: QRCode.QRCodeToDataURLOptions = {
  errorCorrectionLevel: "M",
  type: "image/png",
  margin: 2,
  width: 400,
  color: {
    dark: "#000000",
    light: "#FFFFFF",
  },
};

/**
 * Generate a QR code data URL from an Osapiens SalesOrder object.
 * The JSON is minified before encoding to maximise data density.
 */
export async function generateQrCode(salesOrder: OsapiensSalesOrder): Promise<string> {
  const minified = JSON.stringify(salesOrder);

  // Warn if payload is approaching QR code capacity limits
  if (minified.length > 2500) {
    console.warn(
      `[QR] Payload size ${minified.length} chars is approaching QR code limit (2953). ` +
        `Order: ${salesOrder.orderNumber}`
    );
  }

  const dataUrl = await QRCode.toDataURL(minified, QR_OPTIONS);
  return dataUrl;
}

/**
 * Calculate the approximate byte size of a SalesOrder payload.
 */
export function estimatePayloadSize(salesOrder: OsapiensSalesOrder): number {
  return JSON.stringify(salesOrder).length;
}
