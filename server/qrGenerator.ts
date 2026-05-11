/**
 * QR code generator for Osapiens Dispatch (OSAPV1EDP) plain text payloads.
 *
 * Format (semicolon-delimited plain text):
 *   OSAPV1EDP;<EOID>;<ISO8601_datetime>;<destType>;<FID>;<transportMode>;<vehicle>;
 *   <SSCC>;<trackingNo>;<EMCS>;<SAAD>;<MRN>;<autoArrival>;<custom13>;<custom14>;
 *   <productCount>;<GTIN1>;<qty1>[;<GTIN2>;<qty2>...]
 *
 * Field positions:
 *   0  - Version/Process Prefix: always "OSAPV1EDP"
 *   1  - Reference Document / EOID (customer Economic Operator ID)
 *   2  - Dispatch Event Time (ISO 8601 with timezone, e.g. 2025-04-28T15:30:00+01:00)
 *   3  - Destination Type (2 = fixed quantity EU)
 *   4  - Destination FID (customer Facility Identifier)
 *   5  - Transport Mode (3 = Road transport)
 *   6  - Transport Vehicle identifier
 *   7  - Containerized in SSCC (empty if not applicable)
 *   8  - Postal Tracking Number (empty if not applicable)
 *   9  - Dispatch under EMCS (empty if not applicable)
 *   10 - SAAD Number (empty if not applicable)
 *   11 - MRN Number (empty if not applicable)
 *   12 - Auto Arrival (always FALSE)
 *   13 - Custom field 13 (empty)
 *   14 - Custom field 14 (empty)
 *   15 - Product Count (0 per Osapiens convention)
 *   16+x*2 - Product GTIN (EAN/barcode)
 *   17+x*2 - Product Quantity
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

export interface DispatchQrParams {
  /** Customer EOID (Economic Operator ID) from Xentral freifeld5 */
  eoid: string;
  /** Customer Facility ID from Xentral freifeld6 */
  fid: string;
  /** Dispatch event time — defaults to current time if not provided */
  eventTime?: Date;
  /** Destination type — 2 = fixed quantity EU (default) */
  destinationType?: number;
  /** Transport mode — 3 = Road (default) */
  transportMode?: number;
  /** Transport vehicle identifier (e.g. truck plate number) */
  transportVehicle?: string;
  /** SSCC container code (optional) */
  sscc?: string;
  /** Postal tracking number (optional) */
  trackingNumber?: string;
  /** EMCS ARC number (optional) */
  emcs?: string;
  /** SAAD number (optional) */
  saad?: string;
  /** MRN export declaration number (optional) */
  mrn?: string;
  /** Payment method (field 13 — e.g. Invoice, Prepayment) */
  paymentMethod?: string;
  /** Delivery/shipping method (field 14 — e.g. DHL, Courier) */
  deliveryMethod?: string;
  /** Product line items — each must have a GTIN and quantity */
  products: Array<{
    gtin: string;
    quantity: number;
  }>;
}

/**
 * Format a Date as ISO 8601 with local timezone offset (e.g. 2025-04-28T15:30:00+01:00).
 * Uses the server's local timezone offset.
 */
function formatEventTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset(); // minutes
  const sign = tzOffset >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffset);
  const hours = Math.floor(absOffset / 60);
  const minutes = absOffset % 60;
  const tzStr = `${sign}${pad(hours)}:${pad(minutes)}`;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tzStr}`
  );
}

/**
 * Build the OSAPV1EDP semicolon-delimited plain text string for the QR code.
 * This is the exact format the Osapiens scanner expects for a dispatch event.
 */
export function buildDispatchQrText(params: DispatchQrParams): string {
  const {
    eoid,
    fid,
    eventTime = new Date(),
    destinationType = 2,
    transportMode = 3,
    transportVehicle = "",
    sscc = "",
    trackingNumber = "",
    emcs = "",
    saad = "",
    mrn = "",
    paymentMethod = "",
    deliveryMethod = "",
    products,
  } = params;

  const fields: string[] = [
    "OSAPV1EDP",          // 0 - Version/Process Prefix
    eoid,                  // 1 - EOID (Reference Document)
    formatEventTime(eventTime), // 2 - Dispatch Event Time
    String(destinationType), // 3 - Destination Type
    fid,                   // 4 - Destination FID
    String(transportMode), // 5 - Transport Mode
    transportVehicle,      // 6 - Transport Vehicle
    sscc,                  // 7 - SSCC
    trackingNumber,        // 8 - Postal Tracking Number
    emcs,                  // 9 - EMCS
    saad,                  // 10 - SAAD
    mrn,                   // 11 - MRN
    "FALSE",               // 12 - Auto Arrival
    paymentMethod,         // 13 - Payment Method
    deliveryMethod,        // 14 - Delivery Method
    "0",                   // 15 - Product Count (always 0 per Osapiens convention)
  ];

  // Append product pairs: GTIN;Quantity for each product
  for (const product of products) {
    fields.push(product.gtin);
    fields.push(String(product.quantity));
  }

  return fields.join(";");
}

/**
 * Generate a QR code data URL from the OSAPV1EDP dispatch plain text string.
 * Produces a base64-encoded PNG data URL suitable for embedding in HTML.
 */
export async function generateDispatchQrCode(params: DispatchQrParams): Promise<{
  dataUrl: string;
  plainText: string;
}> {
  const plainText = buildDispatchQrText(params);

  if (plainText.length > 2953) {
    console.warn(
      `[QR] Dispatch payload size ${plainText.length} chars exceeds QR code limit (2953). ` +
        `EOID: ${params.eoid}`
    );
  }

  const dataUrl = await QRCode.toDataURL(plainText, QR_OPTIONS);
  return { dataUrl, plainText };
}

/**
 * @deprecated Use generateDispatchQrCode() instead.
 * Legacy JSON-based QR code generator — kept for backward compatibility only.
 * The Osapiens scanner expects the OSAPV1EDP plain text format, not JSON.
 */
export async function generateQrCode(salesOrder: OsapiensSalesOrder): Promise<string> {
  const minified = JSON.stringify(salesOrder);
  const dataUrl = await QRCode.toDataURL(minified, QR_OPTIONS);
  return dataUrl;
}

/**
 * Calculate the approximate byte size of a dispatch QR payload.
 */
export function estimateDispatchPayloadSize(params: DispatchQrParams): number {
  return buildDispatchQrText(params).length;
}

/**
 * @deprecated Use estimateDispatchPayloadSize() instead.
 */
export function estimatePayloadSize(salesOrder: OsapiensSalesOrder): number {
  return JSON.stringify(salesOrder).length;
}
