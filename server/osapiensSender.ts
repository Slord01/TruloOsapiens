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

import { getDb, getDeliveryNoteById } from "./db";
import { osapiensLogs } from "../drizzle/schema";

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

// ─── DB logger ───────────────────────────────────────────────────────────────

async function logStep(entry: {
  deliveryNoteId: number;
  xentralNumber: string;
  customerName: string | null;
  step: string;
  httpStatus?: number;
  success: boolean;
  responseBody?: string;
  errorMessage?: string;
}) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(osapiensLogs).values({
      deliveryNoteId: entry.deliveryNoteId,
      xentralNumber: entry.xentralNumber,
      customerName: entry.customerName ?? null,
      step: entry.step,
      httpStatus: entry.httpStatus ?? null,
      success: entry.success,
      responseBody: entry.responseBody ?? null,
      errorMessage: entry.errorMessage ?? null,
    });
  } catch (e) {
    // Non-fatal — don't let logging failures break the send
    console.error("[Osapiens] Failed to write log entry:", e);
  }
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

  const orderItems = note.items.map((item) => ({
    Name: item.productName ?? "",
    Sku: item.productNumber ?? "",
    UnitGtin: item.ean ?? "",
    OrderedQty: item.quantity ? parseFloat(item.quantity) : 0,
    CaseGtin: "",
    CaseQty: 0,
    BundleGtin: "",
    BundleQty: 0,
    OrderLevel: "unit",
  }));

  return {
    object: "SalesOrder",
    action: "Create",
    key: note.xentralNumber,
    data: {
      OrderNumber: note.xentralNumber,
      CreationDate: now,
      DeliveryDate: note.deliveryDate ?? "",
      State: "CREATED",
      SendingSystem: "TNT-Bridge",
      SoldToParty: {
        Name: note.customerName ?? "",
        EoId: note.eoid ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: "",
      },
      DeliveryPoint: {
        FacilityId: note.fid ?? "",
        Name: note.customerName ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: "",
      },
      ScanningPoint: {
        FacilityId: ourFid,
        Address: "",
        City: "",
        Zip: "",
        Country: "DE",
        ExternalReference: "",
        Name: "Trulo GmbH Warehouse",
      },
      OrderItems: orderItems,
      OverallScannedCodes: [],
      CurrentlyScannedCodes: [],
      PickedItems: {},
      FinishedAt: "",
    },
  };
}

// ─── Delivery Point upsert ───────────────────────────────────────────────────

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
  },
  logCtx: { deliveryNoteId: number; xentralNumber: string; customerName: string | null }
): Promise<void> {
  // Step 1: Ensure the customer Organisation exists
  const orgKey = note.eoid ?? note.fid;
  const orgReadResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ object: "Organization", action: "Read", key: orgKey }),
  });
  const orgReadJson = (await orgReadResp.json()) as { error?: boolean; data?: unknown };

  if (orgReadJson.error !== false || orgReadJson.data == null) {
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
    const orgBody = JSON.stringify(orgCreateJson);
    await logStep({
      ...logCtx,
      step: "Organisation",
      httpStatus: orgCreateResp.status,
      success: !orgCreateJson.error,
      responseBody: orgBody,
      errorMessage: orgCreateJson.error ? orgCreateJson.message : undefined,
    });
    if (orgCreateJson.error) {
      console.warn(`[Osapiens] Organization Create warning for ${orgKey}:`, orgCreateJson.message);
    } else {
      console.log(`[Osapiens] Organization created for EOID: ${orgKey}`);
    }
  }

  // Step 2: Always Create DeliveryPoint with unique timestamped key to avoid ghost-record collisions
  const dpKey = `dp-${note.fid}-${Date.now()}`;
  const createResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({
      object: "DeliveryPoint",
      action: "Create",
      key: dpKey,
      data: {
        EU: true,
        Fid: note.fid,
        ExternalRefNumber: note.fid,
        Eoid: note.eoid ?? "",
        Gln: "",
        VAT: "",
        Name: note.customerName ?? note.fid,
        OrganizationRef: orgKey,
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
  const createJson = (await createResp.json()) as { error?: boolean; message?: string };
  const dpBody = JSON.stringify(createJson);
  await logStep({
    ...logCtx,
    step: "DeliveryPoint",
    httpStatus: createResp.status,
    success: !createJson.error,
    responseBody: dpBody,
    errorMessage: createJson.error ? createJson.message : undefined,
  });
  if (createJson.error) {
    throw new Error(`DeliveryPoint Create failed for FID ${note.fid}: ${createJson.message}`);
  } else {
    console.log(`[Osapiens] DeliveryPoint created OK for FID: ${note.fid} (key: ${dpKey})`);
  }
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

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
      error: "Our warehouse FID is not configured. Please add OSAPIENS_OUR_FID in the app secrets.",
    };
  }

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

  const endpoint = `${cfg.apiUrl.replace(/\/$/, "")}/data/in/rest/${cfg.customer}/tpd/masterdata-v1`;
  const authString = `un.${cfg.username}:${cfg.password}`;
  const authHeader = `Basic ${Buffer.from(authString).toString("base64")}`;

  const logCtx = {
    deliveryNoteId,
    xentralNumber: note.xentralNumber,
    customerName: note.customerName,
  };

  try {
    await ensureDeliveryPoint(endpoint, authHeader, {
      fid: note.fid,
      eoid: note.eoid,
      customerName: note.customerName,
      addressStreet: note.addressStreet,
      addressCity: note.addressCity,
      addressPostalCode: note.addressPostalCode,
      addressCountry: note.addressCountry,
    }, logCtx);
  } catch (dpErr: unknown) {
    const msg = dpErr instanceof Error ? dpErr.message : String(dpErr);
    console.error("[Osapiens] DeliveryPoint upsert failed:", msg);
    return { success: false, error: `Could not register customer delivery point in Osapiens: ${msg}` };
  }

  const payload = buildSalesOrderPayload(note, cfg.ourFid);

  console.log(`[Osapiens] Creating Sales Order for delivery note ${note.xentralNumber} (DB id: ${deliveryNoteId})`);
  console.log(`[Osapiens] Endpoint: ${endpoint}`);
  console.log(`[Osapiens] Customer: ${note.customerName}, FID: ${note.fid}, EOID: ${note.eoid}`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text();
    console.log(`[Osapiens] Response: ${response.status} — ${responseBody.substring(0, 200)}`);

    await logStep({
      ...logCtx,
      step: "SalesOrder",
      httpStatus: response.status,
      success: response.ok,
      responseBody,
      errorMessage: response.ok ? undefined : responseBody.substring(0, 1000),
    });

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
    await logStep({
      ...logCtx,
      step: "SalesOrder",
      success: false,
      errorMessage: `Network error: ${message}`,
    });
    return { success: false, error: `Network error: ${message}` };
  }
}
