/**
 * xentralPoller.ts
 * Actively fetches delivery notes from the Xentral V3 REST API and processes
 * each one through the existing webhook pipeline.
 *
 * Strategy:
 * 1. Fetch the list of recent delivery notes from V3 (date filter).
 * 2. For each note, fetch the V3 detail which includes lineItems with product IDs.
 * 3. Check if ANY line item product ID is in the tobacco cache (Category 95000).
 *    → If no tobacco products found: skip entirely (never write to DB).
 *    → If already in DB as "ready": skip (no re-processing needed).
 * 4. For tobacco notes only: fetch free fields for EOID, then run full pipeline.
 *
 * This means the DB only ever contains tobacco delivery notes, and repeat
 * fetches are near-instant for already-processed notes.
 *
 * API reference: https://developer.xentral.com/reference/getapi-v3-deliverynotes
 */

import { processWebhookPayload } from "./webhookProcessor";
import { refreshProductCache, isTobaccoProduct, isTobaccoProductNumber } from "./productCache";
import { getDeliveryNoteByXentralId } from "./db";

export interface PollResult {
  fetched: number;
  /** Tobacco notes found (before DB check) */
  tobaccoFound: number;
  /** Newly inserted or updated records */
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
 * Fetch the V3 detail for a delivery note, remap to the shape expected by
 * processWebhookPayload, and include free fields for EOID lookup.
 */
async function fetchNoteDetail(
  baseUrl: string,
  id: string,
  listNote: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  // V3 detail includes lineItems with product IDs — primary source
  // include[]=lineItems is required; without it Xentral omits the array entirely
  try {
    const detailUrl = new URL(`${baseUrl}/api/v3/deliveryNotes/${id}`);
    detailUrl.searchParams.set("include[0]", "lineItems");
    const v3Response = await fetchWithTimeout(
      detailUrl.toString(),
      { headers }
    );
    if (v3Response.ok) {
      const v3Data = (await v3Response.json()) as { data?: unknown };
      const v3Note = (v3Data?.data ?? v3Data) as Record<string, unknown>;
      const docAddr = v3Note.documentAddress as Record<string, unknown> | undefined;
      const addressId = String(
        (v3Note.address as Record<string, unknown> | undefined)?.id ?? ""
      );

      // Remap V3 lineItems → positions shape expected by dataMapper
      const lineItems = (v3Note.lineItems as unknown[]) ?? [];
      // Extract sales order number from the salesOrder reference object
      const salesOrderRef = v3Note.salesOrder as Record<string, unknown> | undefined;
      const salesOrderNumber = String(salesOrderRef?.documentNumber ?? salesOrderRef?.number ?? "") || undefined;
      const positions = lineItems
        .filter((li) => {
          const item = li as Record<string, unknown>;
          return item.type === "product";
        })
        .map((li) => {
          const item = li as Record<string, unknown>;
          const prod = item.product as Record<string, unknown> | undefined;
          return {
            product: {
              id: String(prod?.id ?? ""),
              number: String(item.number ?? prod?.number ?? ""),
              name: String(item.name ?? prod?.name ?? ""),
              ean: prod?.ean ? String(prod.ean) : undefined,
            },
            quantity: item.quantity,
            unit: item.unit,
            price: undefined,
          };
        });

      // Fetch EOID and FID from Xentral V1 address record
      // freifeld5 = EOID, freifeld6 = FID (facility identifier)
      let freeFields: Array<{ name?: string; value?: string }> = [];
      let fidFromAddress: string | undefined = undefined;
      if (addressId) {
        try {
          const addrResp = await fetchWithTimeout(
            `${baseUrl}/api/v1/adressen/${addressId}`,
            { headers },
            5_000
          );
          if (addrResp.ok) {
            const addrData = (await addrResp.json()) as { data?: Record<string, unknown> };
            const addrRecord = addrData?.data ?? addrData as Record<string, unknown>;
            // freifeld5 = EOID, freifeld6 = FID (facility identifier)
            const eoidValue = String(
              addrRecord?.freifeld5 ?? addrRecord?.FREIFELD5 ?? addrRecord?.adresse_freifeld5 ?? ""
            ).trim();
            const fidValue = String(
              addrRecord?.freifeld6 ?? addrRecord?.FREIFELD6 ?? addrRecord?.adresse_freifeld6 ?? ""
            ).trim();
            if (eoidValue) {
              // Normalise into the freeFields array shape that dataMapper expects
              freeFields = [{ name: "EOID Nummer", value: eoidValue }];
              console.log(`[Poller] EOID from freifeld5 for address ${addressId}: "${eoidValue}"`);
            } else {
              console.log(`[Poller] freifeld5 empty for address ${addressId} — EOID will be missing`);
            }
            if (fidValue) {
              console.log(`[Poller] FID from freifeld6 for address ${addressId}: "${fidValue}"`);
            } else {
              console.log(`[Poller] freifeld6 empty for address ${addressId} — FID will be missing`);
            }
            // FID is stored separately and passed as a top-level customer.fid property
            fidFromAddress = fidValue || undefined;
          }
        } catch {
          // Address lookup unavailable — EOID will be missing, mapping will flag it
        }
      }

      return {
        ...v3Note,
        id: v3Note.id,
        documentNumber: v3Note.documentNumber,
        number: v3Note.documentNumber,
        date: v3Note.documentDate,
        salesOrderNumber,
        positions,
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
          fid: fidFromAddress,
        },
      };
    }
  } catch {
    // V3 timed out or failed — use list-level data as last resort
  }

  // Last resort: list-level data only (mapping will likely produce an error record)
  return {
    ...listNote,
    id: listNote.id,
    documentNumber: listNote.documentNumber ?? listNote.number,
    number: listNote.documentNumber ?? listNote.number,
    date: listNote.documentDate ?? listNote.date,
  };
}

/**
 * Fetch delivery notes from Xentral created in the last `lookbackDays` days.
 * Only tobacco notes (Category 95000) are processed and saved to the database.
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
    tobaccoFound: 0,
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

    try {
      // Fetch V3 detail — this gives us lineItems with product IDs
      const fullNote = await fetchNoteDetail(baseUrl!, id, note, headers);

      // Pre-filter: check if any position is a tobacco product
      // Uses SKU prefix "95" as primary check (works without cache),
      // and Category 95000 cache as secondary check.
      const positions = (fullNote.positions as Array<Record<string, unknown>>) ?? [];
      const hasTobacco = positions.some((pos) => {
        const prod = pos.product as Record<string, unknown> | undefined;
        const productNumber = String(prod?.number ?? "");
        if (productNumber && isTobaccoProductNumber(productNumber)) return true;
        const productId = String(prod?.id ?? "");
        if (productId && isTobaccoProduct(productId)) return true;
        return false;
      });

      if (!hasTobacco) {
        // Not a tobacco order — skip silently, do not write to DB
        result.skipped++;
        return;
      }

      result.tobaccoFound++;

      // Check if already in DB as "ready" — skip re-processing
      const existing = await getDeliveryNoteByXentralId(id).catch(() => null);
      const isNew = !existing;

      if (existing?.status === "ready") {
        // Already successfully processed — count as skipped, not an error
        result.skipped++;
        result.details.push({ id, number, status: "ready", isNew: false });
        return;
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
      result.details.push({ id, number, status: "error", isNew: true, error: msg });
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

/**
 * Fetch a single delivery note by its Xentral document number (e.g. LN-2026-00123).
 * Uses the documentNumber filter on the V3 list endpoint to find the exact note.
 */
export async function fetchDeliveryNoteByDocumentNumber(
  documentNumber: string
): Promise<PollResult> {
  const baseUrl = (process.env.XENTRAL_API_URL ?? process.env.XENTRAL_BASE_URL)?.replace(/\/$/, "");
  const apiKey = process.env.XENTRAL_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "XENTRAL_API_URL and XENTRAL_API_KEY must be set to fetch orders from Xentral"
    );
  }

  await refreshProductCache();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  const url = new URL(`${baseUrl}/api/v3/deliveryNotes`);
  url.searchParams.set("filter[0][key]", "documentNumber");
  url.searchParams.set("filter[0][op]", "equals");
  url.searchParams.set("filter[0][value]", documentNumber.trim());

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
    tobaccoFound: 0,
    imported: 0,
    errors: 0,
    skipped: 0,
    details: [],
  };

  if (rawNotes.length === 0) return result;

  // Process the single matched note (or the few returned)
  for (const raw of rawNotes) {
    const note = raw as Record<string, unknown>;
    const id = String(note.id ?? "");
    const number = String(note.documentNumber ?? note.number ?? id);

    try {
      const fullNote = await fetchNoteDetail(baseUrl, id, note, headers);
      result.tobaccoFound++;
      const existing = await getDeliveryNoteByXentralId(id).catch(() => null);
      const isNew = !existing;
      const processed = await processWebhookPayload(fullNote);
      result.details.push({ id, number, status: processed.status, isNew });
      if (processed.status === "ready") {
        if (isNew) result.imported++;
      } else if (processed.status === "error") {
        result.errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.details.push({ id, number, status: "error", isNew: true, error: msg });
      result.errors++;
    }
  }

  return result;
}
