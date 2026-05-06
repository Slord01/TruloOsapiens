/**
 * xentralPoller.ts
 * Actively fetches delivery notes from the Xentral V3 REST API and processes
 * each one through the existing webhook pipeline.
 *
 * API reference: https://developer.xentral.com/reference/getapi-v3-deliverynotes
 * Filter syntax:  filter[n][key] / filter[n][op] / filter[n][value]
 * Endpoint:       GET /api/v3/deliveryNotes
 *
 * Used by the "Fetch Orders" admin button so warehouse staff can pull orders
 * on demand without waiting for Xentral webhooks to be configured.
 */

import { processWebhookPayload } from "./webhookProcessor";
import { refreshProductCache } from "./productCache";
import { getDeliveryNoteByXentralId } from "./db";

export interface PollResult {
  fetched: number;
  /** Number of delivery notes that were newly inserted (not previously in DB) */
  imported: number;
  errors: number;
  skipped: number;
  details: Array<{ id: string; number: string; status: string; isNew: boolean; error?: string }>;
}

/**
 * Fetch delivery notes from Xentral created in the last `lookbackDays` days.
 * Uses the V3 API with correct filter syntax, then fetches V1 detail for each
 * note to get positions and customer free fields (including EOID).
 */
export async function fetchAndProcessDeliveryNotes(
  lookbackDays = 7
): Promise<PollResult> {
  const baseUrl = (process.env.XENTRAL_API_URL ?? process.env.XENTRAL_BASE_URL)?.replace(/\/$/, "");
  const apiKey = process.env.XENTRAL_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "XENTRAL_API_URL and XENTRAL_API_KEY must be set to fetch orders from Xentral"
    );
  }

  // Ensure product cache is loaded so tobacco filter works
  await refreshProductCache();

  // Build date filter — Xentral V3 uses YYYY-MM-DD for createdAt
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  const sinceStr = since.toISOString().split("T")[0];

  // Build the V3 list URL with correct filter syntax
  // GET /api/v3/deliveryNotes?filter[0][key]=createdAt&filter[0][op]=greaterThanOrEquals&filter[0][value]=YYYY-MM-DD
  const url = new URL(`${baseUrl}/api/v3/deliveryNotes`);
  url.searchParams.set("filter[0][key]", "createdAt");
  url.searchParams.set("filter[0][op]", "greaterThanOrEquals");
  url.searchParams.set("filter[0][value]", sinceStr);
  url.searchParams.set("sort", "-createdAt"); // newest first
  url.searchParams.set("perPage", "100");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const listResponse = await fetch(url.toString(), { headers });

  if (!listResponse.ok) {
    const body = await listResponse.text().catch(() => "");
    throw new Error(
      `Xentral API error ${listResponse.status} ${listResponse.statusText} — ${body.slice(0, 300)}`
    );
  }

  const listData = (await listResponse.json()) as { data?: unknown[] };
  const rawNotes: unknown[] = listData?.data ?? [];

  const result: PollResult = {
    fetched: rawNotes.length,
    imported: 0,
    errors: 0,
    skipped: 0,
    details: [],
  };

  for (const raw of rawNotes) {
    const note = raw as Record<string, unknown>;
    const id = String(note.id ?? "");
    const number = String(note.documentNumber ?? note.number ?? id);

    // Check if this delivery note already exists in our DB before processing
    const existing = await getDeliveryNoteByXentralId(id).catch(() => null);
    const isNew = !existing;

    try {
      // Fetch full detail from V1 endpoint — it includes positions and customer
      // free fields (where EOID is stored) which V3 does not embed by default.
      const v1DetailUrl = `${baseUrl}/api/v1/deliverynotes/${id}`;
      const v1Response = await fetch(v1DetailUrl, { headers });

      let fullNote: Record<string, unknown>;

      if (v1Response.ok) {
        const v1Data = (await v1Response.json()) as { data?: unknown };
        fullNote = (v1Data?.data ?? v1Data) as Record<string, unknown>;
      } else {
        // Fall back to V3 detail and remap documentAddress → customer.address
        const v3DetailUrl = `${baseUrl}/api/v3/deliveryNotes/${id}`;
        const v3Response = await fetch(v3DetailUrl, { headers });

        if (v3Response.ok) {
          const v3Data = (await v3Response.json()) as { data?: unknown };
          const v3Note = (v3Data?.data ?? v3Data) as Record<string, unknown>;
          const docAddr = v3Note.documentAddress as Record<string, unknown> | undefined;

          // Attempt to load address free fields for EOID
          const addressId = String(
            (v3Note.address as Record<string, unknown> | undefined)?.id ?? ""
          );
          let freeFields: Array<{ name?: string; value?: string }> = [];
          if (addressId) {
            const ffUrl = `${baseUrl}/api/v1/addresses/${addressId}/freefields`;
            const ffResp = await fetch(ffUrl, { headers }).catch(() => null);
            if (ffResp?.ok) {
              const ffData = (await ffResp.json()) as {
                data?: Array<{ name?: string; value?: string }>;
              };
              freeFields = ffData?.data ?? [];
            }
          }

          fullNote = {
            ...v3Note,
            id: v3Note.id,
            number: v3Note.documentNumber,
            date: v3Note.documentDate,
            customer: {
              id: addressId,
              name: docAddr?.name ?? docAddr?.contactPerson ?? "",
              companyName: docAddr?.name ?? "",
              address: {
                street: docAddr?.street ?? "",
                city: docAddr?.city ?? "",
                zipCode: docAddr?.zipCode ?? "",
                countryCode: docAddr?.country ?? "",
              },
              freeFields,
            },
          };
        } else {
          // Last resort: use list-level data (mapping will likely fail with missing fields)
          fullNote = {
            ...note,
            id: note.id,
            number: note.documentNumber ?? note.number,
            date: note.documentDate ?? note.date,
          };
        }
      }

      const processed = await processWebhookPayload(fullNote);
      result.details.push({ id, number, status: processed.status, isNew });

      if (processed.status === "ready") {
        if (isNew) result.imported++;
      } else if (processed.status === "error") {
        result.errors++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push({ id, number, status: "error", isNew, error: msg });
      result.errors++;
      console.error(`[Poller] Failed to process delivery note ${id}:`, err);
    }
  }

  return result;
}
