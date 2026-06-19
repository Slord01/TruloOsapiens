/**
 * osapiensSender.ts
 *
 * Creates a Sales Order in the Osapiens masterdata API so that warehouse staff
 * can open the order in the Osapiens mobile app, scan T&T codes against it, and
 * have Osapiens automatically match the codes to the order and customer.
 *
 * Endpoint: POST [OSAPIENS_API_URL]/data/in/rest/[CUSTOMER]/tpd/masterdata-v1
 * Auth:     HTTP Basic Auth with "un." prefix on username
 * Spec:     TNT_OS_INTERFACES_TECHNICAL-SPEC_v.2.5.pdf Section 5.8
 */

import { getDeliveryNoteById } from "./db";

// ─── Environment helpers ──────────────────────────────────────────────────────

function getOsapiensConfig() {
  const apiUrl = process.env.OSAPIENS_API_URL ?? "";
  const username = process.env.OSAPIENS_USERNAME ?? "";
  const password = process.env.OSAPIENS_PASSWORD ?? "";
  const customer = process.env.OSAPIENS_CUSTOMER ?? "";
  const ourFid = process.env.OSAPIENS_OUR_FID ?? "";

  return { apiUrl, username, password, customer, ourFid };
}

export function isOsapiensConfigured(): boolean {
  const cfg = getOsapiensConfig();
  return !!(cfg.apiUrl && cfg.username && cfg.password && cfg.customer && cfg.ourFid);
}

// ─── Payload builder ──────────────────────────────────────────────────────────

function buildSalesOrderPayload(note: {
  xentralNumber: string;
  customerName: string | null;
  eoid: string | null;
  fid: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
  deliveryDate: string | null;
  deliveryMethod: string | null;
  paymentMethod: string | null;
  orderValue: string | null;
  orderCurrency: string | null;
  items: Array<{
    productNumber: string | null;
    productName: string | null;
    ean: string | null;
    quantity: string | null;
    unitPrice: string | null;
    currency: string | null;
  }>;
}, ourFid: string): object {
  const now = new Date().toISOString();

  // Map line items to Osapiens OrderItems
  const orderItems = note.items.map((item) => ({
    Name: item.productName ?? "",
    Sku: item.productNumber ?? "",
    UnitGtin: item.ean ?? "",
    OrderedQty: item.quantity ? parseFloat(item.quantity) : 0,
    // CaseGtin / BundleGtin not available from Xentral — leave empty
    CaseGtin: "",
    CaseQty: 0,
    BundleGtin: "",
    BundleQty: 0,
    OrderLevel: "unit",
  }));

  return {
    object: "SalesOrder",
    action: "Create",
    // KEY is the primary key in Osapiens — use the Xentral delivery note number
    key: note.xentralNumber,
    data: {
      OrderNumber: note.xentralNumber,
      CreationDate: now,
      DeliveryDate: note.deliveryDate ?? "",
      State: "CREATED",
      SendingSystem: "TNT-Bridge",

      // Sold-to party = the customer
      SoldToParty: {
        Name: note.customerName ?? "",
        EoId: note.eoid ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: "",
      },

      // Delivery point = customer FID (destination facility)
      DeliveryPoint: {
        FacilityId: note.fid ?? "",
        Name: note.customerName ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: "",
      },

      // Scanning point = our warehouse (where staff will scan)
      ScanningPoint: {
        FacilityId: ourFid,
        Address: "",
        City: "",
        Zip: "",
        Country: "DE",
        ExternalReference: "",
        Name: "Trulo GmbH Warehouse",
      },

      // Order line items
      OrderItems: orderItems,

      // Scanning progress — empty at creation, filled by mobile app
      OverallScannedCodes: [],
      CurrentlyScannedCodes: [],
      PickedItems: {},
      FinishedAt: "",
    },
  };
}

// ─── Delivery Point upsert ───────────────────────────────────────────────────

/**
 * Ensure the customer's Delivery Point exists in Osapiens.
 * Uses the customer FID as the KEY. Creates if missing, updates if present.
 * This is required before a SalesOrder can reference the DeliveryPoint.
 */
async function ensureDeliveryPoint(
  endpoint: string,
  authHeader: string,
  note: {
    fid: string;
    eoid: string | null;
    customerName: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressPostalCode: string | null;
    addressCountry: string | null;
  }
): Promise<void> {
  // Step 1: Ensure the customer Organisation exists (required before DeliveryPoint)
  const orgKey = note.eoid ?? note.fid;
  const orgReadResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ object: "Organization", action: "Read", key: orgKey }),
  });
  const orgReadJson = (await orgReadResp.json()) as { error?: boolean };

  if (orgReadJson.error !== false) {
    // Organisation doesn't exist — create it
    const orgCreateResp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        object: "Organization",
        action: "Create",
        key: orgKey,
        data: {
          Name: note.customerName ?? orgKey,
          Eoid: note.eoid ?? "",
          isTpdRelevant: true,
          IsDefault: false,
          Address: {
            Country: note.addressCountry ?? "",
            PostalCode: note.addressPostalCode ?? "",
            Street: note.addressStreet ?? "",
            StreetNumber: "",
            City: note.addressCity ?? "",
          },
        },
      }),
    });
    const orgCreateJson = (await orgCreateResp.json()) as { error?: boolean; message?: string };
    if (orgCreateJson.error) {
      console.warn(`[Osapiens] Organization Create warning for ${orgKey}:`, orgCreateJson.message);
    } else {
      console.log(`[Osapiens] Organization created for EOID: ${orgKey}`);
    }
  }

  // Step 2: Upsert the DeliveryPoint — use FID as the KEY
  const dpKey = note.fid;
  const dpReadResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ object: "DeliveryPoint", action: "Read", key: dpKey }),
  });
  const dpReadJson = (await dpReadResp.json()) as { error?: boolean };

  const action = dpReadJson.error === false ? "Update" : "Create";

  const upsertResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      object: "DeliveryPoint",
      action,
      key: dpKey,
      data: {
        EU: true,
        Fid: note.fid,
        ExternalRefNumber: note.fid,
        Eoid: note.eoid ?? "",
        Gln: "",
        VAT: "",
        Name: note.customerName ?? note.fid,
        // OrganizationRef links this delivery point to the customer's organisation (required by Osapiens)
        ...(action === "Create" ? { OrganizationRef: orgKey } : {}),
        Address: {
          Country: note.addressCountry ?? "",
          PostalCode: note.addressPostalCode ?? "",
          Street: note.addressStreet ?? "",
          StreetNumber: "",
          City: note.addressCity ?? "",
        },
      },
    }),
  });
  const upsertJson = (await upsertResp.json()) as { error?: boolean; message?: string };
  if (upsertJson.error) {
    console.warn(`[Osapiens] DeliveryPoint ${action} warning:`, upsertJson.message);
  } else {
    console.log(`[Osapiens] DeliveryPoint ${action} OK for FID: ${note.fid}`);
  }
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

/**
 * Send a Sales Order to the Osapiens masterdata API for a given delivery note.
 * Warehouse staff then open the order in the Osapiens mobile app and scan T&T codes.
 * Returns a result object — never throws.
 */
export async function sendDispatchToOsapiens(deliveryNoteId: number): Promise<SendResult> {
  const cfg = getOsapiensConfig();

  if (!cfg.apiUrl || !cfg.username || !cfg.password || !cfg.customer) {
    return {
      success: false,
      error:
        "Osapiens API credentials are not configured. Please add OSAPIENS_API_URL, OSAPIENS_USERNAME, OSAPIENS_PASSWORD, and OSAPIENS_CUSTOMER in the app secrets.",
    };
  }

  if (!cfg.ourFid) {
    return {
      success: false,
      error:
        "Our warehouse FID is not configured. Please add OSAPIENS_OUR_FID in the app secrets.",
    };
  }

  // Fetch the delivery note (with line items) from DB
  const note = await getDeliveryNoteById(deliveryNoteId);
  if (!note) {
    return { success: false, error: `Delivery note ${deliveryNoteId} not found` };
  }

  if (!note.fid) {
    return {
      success: false,
      error: `Customer FID is missing for this order. Please add the customer's FID to Xentral (freifeld6) and re-fetch the order.`,
    };
  }

  if (!note.eoid) {
    return {
      success: false,
      error: `Customer EOID is missing for this order. Please add the customer's EOID to Xentral (freifeld5) and re-fetch the order.`,
    };
  }

  // Ensure the customer's Delivery Point exists in Osapiens before creating the Sales Order
  const endpoint = `${cfg.apiUrl.replace(/\/$/, "")}/data/in/rest/${cfg.customer}/tpd/masterdata-v1`;
  const authString = `un.${cfg.username}:${cfg.password}`;
  const authHeader = `Basic ${Buffer.from(authString).toString("base64")}`;

  try {
    await ensureDeliveryPoint(endpoint, authHeader, {
      fid: note.fid,
      eoid: note.eoid,
      customerName: note.customerName,
      addressStreet: note.addressStreet,
      addressCity: note.addressCity,
      addressPostalCode: note.addressPostalCode,
      addressCountry: note.addressCountry,
    });
  } catch (dpErr) {
    console.warn("[Osapiens] Could not upsert DeliveryPoint:", dpErr);
    // Non-fatal — attempt the SalesOrder anyway
  }

  const payload = buildSalesOrderPayload(note, cfg.ourFid);

  // Endpoint and auth already built above

  console.log(
    `[Osapiens] Creating Sales Order for delivery note ${note.xentralNumber} (DB id: ${deliveryNoteId})`
  );
  console.log(`[Osapiens] Endpoint: ${endpoint}`);
  console.log(
    `[Osapiens] Customer: ${note.customerName}, FID: ${note.fid}, EOID: ${note.eoid}`
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();
    console.log(
      `[Osapiens] Response: ${response.status} — ${responseBody.substring(0, 200)}`
    );

    if (response.ok) {
      return { success: true, statusCode: response.status, responseBody };
    } else {
      return {
        success: false,
        statusCode: response.status,
        responseBody,
        error: `Osapiens API returned ${response.status}: ${responseBody.substring(0, 500)}`,
      };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Osapiens] Network error:`, message);
    return { success: false, error: `Network error: ${message}` };
  }
}
