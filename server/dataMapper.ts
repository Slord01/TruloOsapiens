/**
 * Maps a Xentral delivery note webhook payload to the Osapiens SalesOrder JSON schema.
 * Spec reference: TECHNICAL-SPEC-TNT-OS-INTERFACES v1.3.21 — Section 5.8 SalesOrder
 */

export interface XentralPosition {
  id?: string;
  product?: {
    id?: string;
    number?: string;
    name?: string;
    ean?: string;
  };
  quantity?: number | string;
  unit?: string;
  price?: {
    amount?: number | string;
    currency?: string;
  };
}

export interface XentralCustomer {
  id?: string;
  name?: string;
  companyName?: string;
  address?: {
    street?: string;
    city?: string;
    zipCode?: string;
    countryCode?: string;
  };
  freeFields?: Array<{ name?: string; value?: string }>;
}

export interface XentralDeliveryNotePayload {
  id?: string;
  number?: string;
  date?: string;
  customer?: XentralCustomer;
  positions?: XentralPosition[];
  // Alternate flat structure some Xentral versions send
  deliveryNoteNumber?: string;
  deliveryNoteId?: string;
  customerData?: XentralCustomer;
  items?: XentralPosition[];
}

// ─── Osapiens SalesOrder Types ────────────────────────────────────────────────

export interface OsapiensSalesOrderItem {
  productNumber: string;
  productName: string;
  ean?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  currency?: string;
}

export interface OsapiensSalesOrder {
  object: "SalesOrder";
  action: "Create";
  orderNumber: string;
  creationDate: string;
  customer: {
    eoid: string;
    name: string;
    address: {
      street: string;
      city: string;
      postalCode: string;
      country: string;
    };
  };
  items: OsapiensSalesOrderItem[];
}

export interface MappingResult {
  success: boolean;
  salesOrder?: OsapiensSalesOrder;
  missingFields: string[];
  errorMessage?: string;
  // Extracted flat fields for DB storage
  customerId?: string;
  customerName?: string;
  eoid?: string;
  addressStreet?: string;
  addressCity?: string;
  addressPostalCode?: string;
  addressCountry?: string;
}

const EOID_FIELD_NAME = "EOID Number";

/**
 * Extract EOID from customer free fields array.
 * Matches the exact field name "EOID Number" (case-insensitive trim).
 */
function extractEoid(freeFields?: Array<{ name?: string; value?: string }>): string | undefined {
  if (!freeFields || !Array.isArray(freeFields)) return undefined;
  const field = freeFields.find(
    (f) => f.name?.trim().toLowerCase() === EOID_FIELD_NAME.toLowerCase()
  );
  return field?.value?.trim() || undefined;
}

/**
 * Normalise a Xentral delivery note payload (handles both nested and flat structures).
 */
function normalise(raw: XentralDeliveryNotePayload): {
  id: string;
  number: string;
  date: string;
  customer: XentralCustomer;
  positions: XentralPosition[];
} {
  const id = String(raw.id ?? raw.deliveryNoteId ?? "");
  const number = String(raw.number ?? raw.deliveryNoteNumber ?? "");
  const date = String(raw.date ?? new Date().toISOString().split("T")[0]);
  const customer: XentralCustomer = raw.customer ?? raw.customerData ?? {};
  const positions: XentralPosition[] = raw.positions ?? raw.items ?? [];
  return { id, number, date, customer, positions };
}

/**
 * Map a Xentral delivery note to an Osapiens SalesOrder.
 * Returns a MappingResult with success flag and list of any missing mandatory fields.
 */
export function mapDeliveryNoteToSalesOrder(
  raw: XentralDeliveryNotePayload,
  tobaccoPositions: XentralPosition[]
): MappingResult {
  const { id, number, date, customer } = normalise(raw);

  const missingFields: string[] = [];

  // ── Order-level mandatory fields ──
  if (!number) missingFields.push("Delivery Note Number");

  // ── Customer mandatory fields ──
  const eoid = extractEoid(customer.freeFields);
  if (!eoid) missingFields.push(EOID_FIELD_NAME);

  const customerName = customer.companyName ?? customer.name ?? "";
  if (!customerName) missingFields.push("Customer Name");

  const address = customer.address ?? {};
  if (!address.street) missingFields.push("Address Street");
  if (!address.city) missingFields.push("Address City");
  if (!address.zipCode) missingFields.push("Address Postal Code");
  if (!address.countryCode) missingFields.push("Address Country");

  // ── Items ──
  if (tobaccoPositions.length === 0) missingFields.push("Tobacco Product Items");

  const items: OsapiensSalesOrderItem[] = tobaccoPositions.map((pos) => ({
    productNumber: String(pos.product?.number ?? pos.product?.id ?? ""),
    productName: String(pos.product?.name ?? ""),
    ean: pos.product?.ean ?? undefined,
    quantity: Number(pos.quantity ?? 0),
    unit: String(pos.unit ?? "PCE"),
    unitPrice: pos.price?.amount !== undefined ? Number(pos.price.amount) : undefined,
    currency: pos.price?.currency ?? "EUR",
  }));

  const flatFields = {
    customerId: String(customer.id ?? ""),
    customerName,
    eoid,
    addressStreet: address.street ?? "",
    addressCity: address.city ?? "",
    addressPostalCode: address.zipCode ?? "",
    addressCountry: address.countryCode ?? "",
  };

  if (missingFields.length > 0) {
    const firstMissing = missingFields[0];
    const errorMessage = `Missing ${firstMissing} — please update the customer record in Xentral`;
    return {
      success: false,
      missingFields,
      errorMessage,
      ...flatFields,
    };
  }

  const salesOrder: OsapiensSalesOrder = {
    object: "SalesOrder",
    action: "Create",
    orderNumber: number,
    creationDate: date,
    customer: {
      eoid: eoid!,
      name: customerName,
      address: {
        street: address.street!,
        city: address.city!,
        postalCode: address.zipCode!,
        country: address.countryCode!,
      },
    },
    items,
  };

  return {
    success: true,
    salesOrder,
    missingFields: [],
    ...flatFields,
  };
}
