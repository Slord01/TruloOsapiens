/**
 * osapiensSender.ts
 *
 * Sends a dispatch event to the Osapiens REST API using the v2.5 JSON format.
 * Endpoint: POST [OSAPIENS_API_URL]/data/in/rest/[CUSTOMER]/[APPLICATION]/capture-json
 * Auth: HTTP Basic Auth with "un." prefix on username
 * Spec: TNT_OS_INTERFACES_TECHNICAL-SPEC_v.2.5.pdf Section 3.8
 */

import { getDeliveryNoteById } from "./db";

// ─── Environment helpers ──────────────────────────────────────────────────────

function getOsapiensConfig() {
  const apiUrl = process.env.OSAPIENS_API_URL ?? "";
  const username = process.env.OSAPIENS_USERNAME ?? "";
  const password = process.env.OSAPIENS_PASSWORD ?? "";
  const customer = process.env.OSAPIENS_CUSTOMER ?? "";
  // Application defaults to "tpd" (Tobacco Products Directive) if not set
  const application = process.env.OSAPIENS_APPLICATION ?? "tpd";
  const ourEoid = process.env.OSAPIENS_OUR_EOID ?? "";
  const ourFid = process.env.OSAPIENS_OUR_FID ?? "";

  return { apiUrl, username, password, customer, application, ourEoid, ourFid };
}

export function isOsapiensConfigured(): boolean {
  const cfg = getOsapiensConfig();
  return !!(cfg.apiUrl && cfg.username && cfg.password && cfg.customer && cfg.ourEoid && cfg.ourFid);
}

// ─── Payload builder ──────────────────────────────────────────────────────────

interface DispatchEventInput {
  /** Customer FID (destination facility) */
  customerFid: string;
  /** Delivery note number used as the desadv bizTransaction */
  deliveryNoteNumber: string;
  /** Dispatch date-time in ISO 8601 format */
  eventTime: string;
  /** Timezone offset string e.g. "+01:00" */
  eventTimeZoneOffset: string;
  /** Our company EOID */
  ourEoid: string;
  /** Our facility FID */
  ourFid: string;
  /** Transport mode: 0=Other,1=Sea,2=Rail,3=Road,4=Air,5=Postal,7=Fixed,8=Inland */
  transportMode?: number;
  /** Vehicle identifier */
  transportVehicle?: string;
  /** SSCC container code */
  transportCont2?: string;
  /** Whether we have our own tracking system */
  transportS1?: boolean;
  /** Tracking number (required if transportS1=true) */
  transportS2?: string;
  /** EMCS Administrative Reference Code */
  emcsARC?: string;
  /** SAAD reference number */
  saadNumber?: string;
  /** MRN (Movement Reference Number / export declaration) */
  expDeclarationNumber?: string;
  /** Comment */
  comment?: string;
  /** Destination type: 1=non-EU, 2=fixed qty EU, 3=vending machine EU, 4=vending van EU */
  destinationID1?: number;
  /** Customer name (optional) */
  customerName?: string;
}

function buildDispatchPayload(input: DispatchEventInput): object {
  const now = new Date().toISOString();

  return {
    type: "EPCISDocument",
    schemaVersion: "1.2",
    creationDate: now,
    epcisBody: {
      eventList: [
        {
          type: "ObjectEvent",
          eventTime: input.eventTime,
          eventTimeZoneOffset: input.eventTimeZoneOffset,
          action: "OBSERVE",
          bizStep: "urn:epcglobal:cbv:bizstep:shipping",
          parentID: "",
          "fit:comment": input.comment ?? "",
          "fit:aggregationType": 0,
          "fit:productReturn": false,
          "fit:uiType": 0,
          "fit:destinationID1": input.destinationID1 ?? 2, // 2 = fixed quantity EU delivery
          "fit:destinationID5CountryCode": "",
          "fit:destinationID5City": "",
          "fit:destinationID5Name": input.customerName ?? "",
          "fit:destinationID5PostalCode": "",
          "fit:destinationID5StreetAddressOne": "",
          "fit:destinationID5StreetAddressTwo": "",
          "fit:transportMode": input.transportMode ?? 3, // 3 = Road transport (default)
          "fit:transportVehicle": input.transportVehicle ?? "",
          "fit:transportS1": input.transportS1 ?? false,
          "fit:transportS2": input.transportS2 ?? "",
          "fit:saadNumber": input.saadNumber ?? "",
          "fit:expDeclarationNumber": input.expDeclarationNumber ?? "",
          "fit:transportCont2": input.transportCont2 ?? "",
          "fit:emcsARC": input.emcsARC ?? "",
          epcList: [], // Empty — warehouse staff scan individual T&T codes separately
          childEPCs: null,
          readPoint: {
            "fit:fid": input.ourFid,
            id: "",
          },
          bizLocation: {
            id: "",
          },
          bizTransactionList: [
            {
              type: "urn:osapiens:tpd:businessTransactionId",
              bizTransaction: input.deliveryNoteNumber,
            },
            {
              type: "urn:epcglobal:cbv:btt:desadv",
              bizTransaction: input.deliveryNoteNumber,
            },
          ],
          "fit:eoid": {
            "fit:epc": input.ourEoid,
          },
          "fit:destinationIDList": [
            {
              destinationID: {
                epc: input.customerFid,
                gs1ElementString: "",
                type: input.destinationID1 ?? 2,
              },
            },
          ],
        },
      ],
    },
  };
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

/**
 * Send a dispatch event for a delivery note to the Osapiens API.
 * Returns a result object — never throws.
 */
export async function sendDispatchToOsapiens(deliveryNoteId: number): Promise<SendResult> {
  const cfg = getOsapiensConfig();

  if (!cfg.apiUrl || !cfg.username || !cfg.password || !cfg.customer) {
    return {
      success: false,
      error: "Osapiens API credentials are not configured. Please add OSAPIENS_API_URL, OSAPIENS_USERNAME, OSAPIENS_PASSWORD, and OSAPIENS_CUSTOMER in the app secrets.",
    };
  }

  if (!cfg.ourEoid || !cfg.ourFid) {
    return {
      success: false,
      error: "Our company EOID and FID are not configured. Please add OSAPIENS_OUR_EOID and OSAPIENS_OUR_FID in the app secrets.",
    };
  }

  // Fetch the delivery note from DB
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

  // Build event time from delivery date or now
  const eventDate = note.deliveryDate ? new Date(note.deliveryDate) : new Date();
  const eventTime = eventDate.toISOString();
  // Determine timezone offset — default to +01:00 (CET) for European operations
  const eventTimeZoneOffset = "+01:00";

  const payload = buildDispatchPayload({
    customerFid: note.fid,
    deliveryNoteNumber: note.xentralNumber,
    eventTime,
    eventTimeZoneOffset,
    ourEoid: cfg.ourEoid,
    ourFid: cfg.ourFid,
    customerName: note.customerName ?? undefined,
    transportMode: 3, // Road transport default
  });

  // Build endpoint URL
  const endpoint = `${cfg.apiUrl.replace(/\/$/, "")}/data/in/rest/${cfg.customer}/${cfg.application}/capture-json`;

  // Build Basic Auth header — username must be prefixed with "un."
  const authString = `un.${cfg.username}:${cfg.password}`;
  const authHeader = `Basic ${Buffer.from(authString).toString("base64")}`;

  console.log(`[Osapiens] Sending dispatch event for delivery note ${note.xentralNumber} (DB id: ${deliveryNoteId})`);
  console.log(`[Osapiens] Endpoint: ${endpoint}`);
  console.log(`[Osapiens] Customer FID: ${note.fid}, Our EOID: ${cfg.ourEoid}, Our FID: ${cfg.ourFid}`);

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
    console.log(`[Osapiens] Response: ${response.status} — ${responseBody.substring(0, 200)}`);

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
