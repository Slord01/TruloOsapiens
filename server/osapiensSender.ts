/**
 * Sends a mapped Xentral delivery note to the Osapiens TPD masterdata API.
 *
 * The customer is created as a `Customer` record, which is displayed as a
 * Sold-to Party in the Osapiens portal.  Customer organisations are never
 * created by this integration: the Customer is linked to the existing TRULO
 * organisation, and the DeliveryPoint remains the customer destination.
 */
import { getDb, getDeliveryNoteById } from "./db";
import { osapiensLogs } from "../drizzle/schema";

type LogContext = {
  deliveryNoteId: number;
  xentralNumber: string;
  customerName: string | null;
};

type ApiBody = {
  error?: boolean;
  errorCode?: string;
  message?: string;
  data?: unknown;
};

type ApiCallResult = {
  httpStatus: number;
  body: string;
  json: ApiBody;
  success: boolean;
  alreadyExists: boolean;
};

function getOsapiensConfig() {
  return {
    apiUrl: process.env.OSAPIENS_API_URL ?? "",
    username: process.env.OSAPIENS_USERNAME ?? "",
    password: process.env.OSAPIENS_PASSWORD ?? "",
    customer: process.env.OSAPIENS_CUSTOMER ?? "",
    ourFid: process.env.OSAPIENS_OUR_FID ?? "",
    ourEoid: process.env.OSAPIENS_OUR_EOID ?? "",
  };
}

export function isOsapiensConfigured(): boolean {
  const cfg = getOsapiensConfig();
  return !!(cfg.apiUrl && cfg.username && cfg.password && cfg.customer && cfg.ourFid && cfg.ourEoid);
}

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
  } catch (error) {
    // Audit logging must never block an operational submission.
    console.error("[Osapiens] Failed to write log entry:", error);
  }
}

function parseApiBody(body: string): ApiBody {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed as ApiBody : {};
  } catch {
    return {};
  }
}

function apiError(result: ApiCallResult): string {
  return result.json.message || result.body.substring(0, 1_000) || `HTTP ${result.httpStatus}`;
}

async function callMasterdata(
  endpoint: string,
  authHeader: string,
  request: object,
  step: string,
  logCtx: LogContext,
): Promise<ApiCallResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(request),
    });
    const body = await response.text();
    const json = parseApiBody(body);
    const alreadyExists = json.errorCode === "BO_ALREADY_EXIST";
    const success = (response.ok && json.error !== true) || alreadyExists;

    await logStep({
      ...logCtx,
      step,
      httpStatus: response.status,
      success,
      responseBody: body,
      errorMessage: success ? undefined : apiError({ httpStatus: response.status, body, json, success, alreadyExists }),
    });

    return { httpStatus: response.status, body, json, success, alreadyExists };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logStep({ ...logCtx, step, success: false, errorMessage: `Network error: ${message}` });
    throw new Error(`${step} network error: ${message}`);
  }
}

async function resolveOwnOrganizationKey(
  endpoint: string,
  authHeader: string,
  ownEoid: string,
  logCtx: LogContext,
): Promise<string> {
  const result = await callMasterdata(
    endpoint,
    authHeader,
    { object: "Organization", action: "List", data: { limit: 100, startKey: "", offset: 0, indexes: [] } },
    "Organization Lookup",
    logCtx,
  );
  if (!result.success || !Array.isArray(result.json.data)) {
    throw new Error(`Could not read the TRULO organisation: ${apiError(result)}`);
  }

  const organisation = result.json.data.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { Eoid?: unknown }).Eoid === ownEoid;
  }) as { KEY?: unknown } | undefined;
  const organizationKey = typeof organisation?.KEY === "string" ? organisation.KEY : undefined;

  if (!organizationKey) {
    throw new Error(`The configured TRULO EOID (${ownEoid}) has no Organisation record in Osapiens.`);
  }
  return organizationKey;
}

async function ensureSoldToParty(
  endpoint: string,
  authHeader: string,
  organizationKey: string,
  note: {
    eoid: string;
    customerName: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressPostalCode: string | null;
    addressCountry: string | null;
  },
  logCtx: LogContext,
): Promise<void> {
  const read = await callMasterdata(
    endpoint,
    authHeader,
    { object: "Customer", action: "Read", key: note.eoid },
    "Sold-to Party Lookup",
    logCtx,
  );
  if (!read.success) throw new Error(`Sold-to Party lookup failed: ${apiError(read)}`);
  if (read.json.data != null) return;

  const create = await callMasterdata(
    endpoint,
    authHeader,
    {
      object: "Customer",
      action: "Create",
      key: note.eoid,
      data: {
        EU: true,
        ExternalRefNumber: note.eoid,
        OrganizationRef: organizationKey,
        Eoid: note.eoid,
        Gln: "",
        VAT: "",
        Name: note.customerName ?? note.eoid,
        Address: {
          Country: note.addressCountry ?? "",
          PostalCode: note.addressPostalCode ?? "",
          Street: note.addressStreet ?? "",
          StreetNumber: "",
          City: note.addressCity ?? "",
        },
      },
    },
    "Sold-to Party Create",
    logCtx,
  );
  if (!create.success) throw new Error(`Sold-to Party creation failed: ${apiError(create)}`);
  console.log(`[Osapiens] Sold-to Party ready for EOID: ${note.eoid}`);
}

async function ensureDeliveryPoint(
  endpoint: string,
  authHeader: string,
  organizationKey: string,
  note: {
    fid: string;
    eoid: string;
    customerName: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressPostalCode: string | null;
    addressCountry: string | null;
  },
  logCtx: LogContext,
): Promise<void> {
  // The timestamped key avoids historic non-DeliveryPoint key collisions. Osapiens
  // resolves destination selection by the FID, which remains stable for the customer.
  const deliveryPointKey = `dp-${note.fid}-${Date.now()}`;
  const create = await callMasterdata(
    endpoint,
    authHeader,
    {
      object: "DeliveryPoint",
      action: "Create",
      key: deliveryPointKey,
      data: {
        EU: true,
        Fid: note.fid,
        ExternalRefNumber: note.fid,
        Eoid: note.eoid,
        Gln: "",
        VAT: "",
        Name: note.customerName ?? note.fid,
        // The supplied API specification has no CustomerRef on DeliveryPoint. Both
        // Customer (portal label: Sold-to Party) and DeliveryPoint require the same
        // existing TRULO OrganizationRef; the common customer EOID/FID is carried
        // into the embedded SalesOrder party and destination objects.
        OrganizationRef: organizationKey,
        Address: {
          Country: note.addressCountry ?? "",
          PostalCode: note.addressPostalCode ?? "",
          Street: note.addressStreet ?? "",
          StreetNumber: "",
          City: note.addressCity ?? "",
        },
      },
    },
    "DeliveryPoint Create",
    logCtx,
  );
  if (!create.success) throw new Error(`DeliveryPoint creation failed for FID ${note.fid}: ${apiError(create)}`);
  console.log(`[Osapiens] DeliveryPoint ready for FID: ${note.fid}`);
}

function buildSalesOrderPayload(
  note: {
    xentralNumber: string;
    customerName: string | null;
    eoid: string | null;
    fid: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressPostalCode: string | null;
    addressCountry: string | null;
    deliveryDate: string | null;
    items: Array<{
      productNumber: string | null;
      productName: string | null;
      ean: string | null;
      quantity: string | null;
    }>;
  },
  ourFid: string,
): object {
  return {
    object: "SalesOrder",
    action: "Create",
    key: note.xentralNumber,
    data: {
      OrderNumber: note.xentralNumber,
      CreationDate: new Date().toISOString(),
      DeliveryDate: note.deliveryDate ?? "",
      State: "CREATED",
      SendingSystem: "TNT-Bridge",
      // SoldToParty is the embedded address data expected by SalesOrder.
      SoldToParty: {
        Name: note.customerName ?? "",
        EoId: note.eoid ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: note.eoid ?? "",
      },
      // The customer destination that Osapiens scanner operations must resolve.
      DeliveryPoint: {
        FacilityId: note.fid ?? "",
        Name: note.customerName ?? "",
        Address: note.addressStreet ?? "",
        City: note.addressCity ?? "",
        Zip: note.addressPostalCode ?? "",
        Country: note.addressCountry ?? "",
        ExternalReference: note.fid ?? "",
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
      OrderItems: note.items.map((item) => ({
        Name: item.productName ?? "",
        Sku: item.productNumber ?? "",
        UnitGtin: item.ean ?? "",
        OrderedQty: item.quantity ? parseFloat(item.quantity) : 0,
        CaseGtin: "",
        CaseQty: 0,
        BundleGtin: "",
        BundleQty: 0,
        OrderLevel: "unit",
      })),
      OverallScannedCodes: [],
      CurrentlyScannedCodes: [],
      PickedItems: {},
      FinishedAt: "",
    },
  };
}

export interface SendResult {
  success: boolean;
  alreadyExisted?: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

export async function sendDispatchToOsapiens(deliveryNoteId: number): Promise<SendResult> {
  const cfg = getOsapiensConfig();
  if (!cfg.apiUrl || !cfg.username || !cfg.password || !cfg.customer) {
    return { success: false, error: "Osapiens API credentials are not configured." };
  }
  if (!cfg.ourFid || !cfg.ourEoid) {
    return { success: false, error: "TRULO warehouse FID or EOID is not configured in the app secrets." };
  }

  const note = await getDeliveryNoteById(deliveryNoteId);
  if (!note) return { success: false, error: `Delivery note ${deliveryNoteId} not found` };
  if (!note.fid) return { success: false, error: "Customer FID is missing. Add it to Xentral freifeld6 and re-fetch the order." };
  if (!note.eoid) return { success: false, error: "Customer EOID is missing. Add it to Xentral freifeld5 and re-fetch the order." };

  const endpoint = `${cfg.apiUrl.replace(/\/$/, "")}/data/in/rest/${cfg.customer}/tpd/masterdata-v1`;
  const authHeader = `Basic ${Buffer.from(`un.${cfg.username}:${cfg.password}`).toString("base64")}`;
  const logCtx: LogContext = { deliveryNoteId, xentralNumber: note.xentralNumber, customerName: note.customerName };

  try {
    const organizationKey = await resolveOwnOrganizationKey(endpoint, authHeader, cfg.ourEoid, logCtx);
    await ensureSoldToParty(endpoint, authHeader, organizationKey, {
      eoid: note.eoid,
      customerName: note.customerName,
      addressStreet: note.addressStreet,
      addressCity: note.addressCity,
      addressPostalCode: note.addressPostalCode,
      addressCountry: note.addressCountry,
    }, logCtx);
    await ensureDeliveryPoint(endpoint, authHeader, organizationKey, {
      fid: note.fid,
      eoid: note.eoid,
      customerName: note.customerName,
      addressStreet: note.addressStreet,
      addressCity: note.addressCity,
      addressPostalCode: note.addressPostalCode,
      addressCountry: note.addressCountry,
    }, logCtx);

    console.log(`[Osapiens] Creating SalesOrder ${note.xentralNumber} for destination FID ${note.fid}`);
    const result = await callMasterdata(
      endpoint,
      authHeader,
      buildSalesOrderPayload(note, cfg.ourFid),
      "SalesOrder Create",
      logCtx,
    );
    if (!result.success) {
      return {
        success: false,
        statusCode: result.httpStatus,
        responseBody: result.body,
        error: `Osapiens API returned ${result.httpStatus}: ${apiError(result)}`,
      };
    }
    return {
      success: true,
      alreadyExisted: result.alreadyExists,
      statusCode: result.httpStatus,
      responseBody: result.body,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Osapiens] Submission failed:", message);
    return { success: false, error: message };
  }
}
