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

/** Fetch with a hard timeout — prevents any single Xentral call from hanging forever. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the full detail for a single delivery note.
 * Tries V1 first (includes positions + customer free fields / EOID).
 * Falls back to V3 detail + separate free fields call if V1 fails.
 */
async function fetchNoteDetail(
  baseUrl: string,
  id: string,
  listNote: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  // V1 detail includes positions and customer free fields (EOID lives here)
  try {
    const v1Response = await fetchWithTimeout(
      `${baseUrl}/api/v1/deliverynotes/${id}`,
      { headers }
    );
    if (v1Response.ok) {
      const v1Data = (await v1Response.json()) as { data?: unknown };
      return (v1Data?.data ?? v1Data) as Record<string, unknown>;
    }
  } catch {
    // V1 timed out or failed — fall through to V3
  }

  // V3 detail fallback — remap documentAddress → customer.address shape
  try {
    const v3Response = await fetchWithTimeout(
      `${baseUrl}/api/v3/deliveryNotes/${id}`,
      { headers }
    );
    if (v3Response.ok) {
      const v3Data = (await v3Response.json()) as { data?: unknown };
      const v3Note = (v3Data?.data ?? v3Data) as Record<string, unknown>;
      const docAddr = v3Note.documentAddress as Record<string, unknown> | undefined;
      const addressId = String(
        (v3Note.address as Record<string, unknown> | undefined)?.id ?? ""
      );

      // Try to load free fields for EOID — best effort, 5 s timeout
      let freeFields: Array<{ name?: string; value?: string }> = [];
      if (addressId) {
        try {
          const ffResp = await fetchWithTimeout(
            `${baseUrl}/api/v1/addresses/${addressId}/freefields`,
            { headers },
            5_000
          );
          if (ffResp.ok) {
            const ffData = (await ffResp.json()) as {
              data?: Array<{ name?: string; value?: string }>;
            };
            freeFields = ffData?.data ?? [];
          }
        } catch {
          // Free fields unavailable — EOID will be missing, mapping will flag it
        }
      }

      return {
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
    }
  } catch {
    // V3 also timed out — use list-level data as last resort
  }

  // Last resort: list-level data only (mapping will likely produce an error record)
  return {
    ...listNote,
    id: listNote.id,
    number: listNote.documentNumber ?? listNote.number,
    date: listNote.documentDate ?? listNote.date,
  };
}

/**
 * Fetch delivery notes from Xentral created in the last `lookbackDays` days.
 * Notes are processed in parallel (up to CONCURRENCY at a time) with per-call
 * timeouts so the operation completes quickly even with many records.
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

  // Build date filter — Xentral V3 createdAt requires full datetime: Y-m-dTH:i:sP
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  since.setHours(0, 0, 0, 0);
  const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, "+00:00");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  // Fetch the list of delivery notes from V3
  const url = new URL(`${baseUrl}/api/v3/deliveryNotes`);
  url.searchParams.set("filter[0][key]", "createdAt");
  url.searchParams.set("filter[0][op]", "greaterThanOrEquals");
  url.searchParams.set("filter[0][value]", sinceStr);
  url.searchParams.set("sort", "-createdAt");
  url.searchParams.set("perPage", "100");

  const listResponse = await fetchWithTimeout(url.toString(), { headers }, 15_000);

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

  if (rawNotes.length === 0) return result;

  // Process notes in parallel batches of 5 to avoid overwhelming Xentral
  const CONCURRENCY = 5;

  async function processOne(raw: unknown): Promise<void> {
    const note = raw as Record<string, unknown>;
    const id = String(note.id ?? "");
    const number = String(note.documentNumber ?? note.number ?? id);

    const existing = await getDeliveryNoteByXentralId(id).catch(() => null);
    const isNew = !existing;

    try {
      const fullNote = await fetchNoteDetail(baseUrl!, id, note, headers);
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

  // Run in batches
  for (let i = 0; i < rawNotes.length; i += CONCURRENCY) {
    const batch = rawNotes.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
  }

  return result;
}
