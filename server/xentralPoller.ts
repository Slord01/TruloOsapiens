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

/** Module-level cache for payment method names — populated once per server session */
let _pmCache: Record<string, string> | null = null;
/** Module-level cache for shipping method names — populated once per server session */
let _smCache: Record<string, string> | null = null;

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
      // Extract sales order reference — id for API lookup, documentNumber for display
      const salesOrderRef = v3Note.salesOrder as Record<string, unknown> | undefined;
      const salesOrderNumber = String(salesOrderRef?.documentNumber ?? salesOrderRef?.number ?? "") || undefined;
      const salesOrderId = String(salesOrderRef?.id ?? "") || undefined;

      // Fetch sales order details for payment method, delivery method, and item prices
      let paymentMethod: string | undefined;
      let deliveryMethod: string | undefined;
      let salesOrderLineItems: Array<Record<string, unknown>> = [];
      if (salesOrderId) {
        try {
          const soUrl = new URL(`${baseUrl}/api/v3/salesOrders/${salesOrderId}`);
          soUrl.searchParams.set("include[0]", "lineItems");
          const soResp = await fetchWithTimeout(soUrl.toString(), { headers }, 8_000);
          if (soResp.ok) {
            const soData = (await soResp.json()) as { data?: Record<string, unknown> };
            const so = soData?.data ?? soData as Record<string, unknown>;
            // Payment method: financials.paymentMethod is {id: N} — resolve name from paymentMethods endpoint
            const financials = so.financials as Record<string, unknown> | undefined;
            const pmRaw = financials?.paymentMethod ?? financials?.paymentCondition ?? so.paymentMethod ?? so.payment;
            if (typeof pmRaw === "object" && pmRaw !== null) {
              const pmObj = pmRaw as Record<string, unknown>;
              const pmName = String(pmObj.name ?? pmObj.description ?? "").trim();
              if (pmName) {
                paymentMethod = pmName;
              } else if (pmObj.id) {
                // Use V1 /api/v1/paymentMethods endpoint (V2/V3 don't expose this)
                // Cache the full list to avoid repeated API calls per fetch run
                if (!_pmCache) {
                  try {
                    // V1 API: fetch all pages using page[number] param
                    // extra = {page:{number:1,size:10},totalCount:29}
                    const tmpCache: Record<string, string> = {};
                    // First fetch to get totalCount and pageSize
                    const pm1Url = new URL(`${baseUrl}/api/v1/paymentMethods`);
                    const pm1Resp = await fetchWithTimeout(pm1Url.toString(), { headers }, 5_000);
                    if (pm1Resp.ok) {
                      const pm1Data = (await pm1Resp.json()) as { data?: Array<Record<string, unknown>>; extra?: { page?: { number?: number; size?: number }; totalCount?: number } };
                      const pmTotalCount = pm1Data?.extra?.totalCount ?? 0;
                      const pmPageSize = pm1Data?.extra?.page?.size ?? 10;
                      const totalPages = Math.ceil(pmTotalCount / pmPageSize);
                      // Load page 1 results
                      for (const pm of pm1Data?.data ?? []) {
                        const pmId = String(pm.id ?? "");
                        const pmDesignation = String(pm.designation ?? pm.name ?? "").trim();
                        if (pmId && pmDesignation) tmpCache[pmId] = pmDesignation;
                      }
                      // Fetch remaining pages (V1 requires both page[number] AND page[size])
                      for (let p = 2; p <= totalPages; p++) {
                        const pmPUrl = new URL(`${baseUrl}/api/v1/paymentMethods`);
                        pmPUrl.searchParams.set("page[number]", String(p));
                        pmPUrl.searchParams.set("page[size]", String(pmPageSize));
                        const pmPResp = await fetchWithTimeout(pmPUrl.toString(), { headers }, 5_000);
                        if (!pmPResp.ok) break;
                        const pmPData = (await pmPResp.json()) as { data?: Array<Record<string, unknown>> };
                        for (const pm of pmPData?.data ?? []) {
                          const pmId = String(pm.id ?? "");
                          const pmDesignation = String(pm.designation ?? pm.name ?? "").trim();
                          if (pmId && pmDesignation) tmpCache[pmId] = pmDesignation;
                        }
                      }
                    }
                    _pmCache = tmpCache;
                    console.log(`[Poller] PM cache loaded: ${Object.keys(_pmCache).length} methods, IDs: ${Object.keys(_pmCache).join("|")}, names: ${Object.values(_pmCache).join("|").substring(0, 400)}`);
                  } catch (e) { console.log(`[Poller] PM V1 exception: ${e}`); }
                }
                paymentMethod = _pmCache?.[String(pmObj.id)] ?? `ID:${pmObj.id}`;
              }
            } else if (typeof pmRaw === "string") {
              paymentMethod = pmRaw.trim() || undefined;
            }
            // Delivery/shipping method: shippingMethod is {id: N} — resolve via V1 list cache
            const dmRaw = so.shippingMethod as Record<string, unknown> | string | undefined;
            if (typeof dmRaw === "object" && dmRaw !== null && dmRaw.name) {
              deliveryMethod = String(dmRaw.name).trim() || undefined;
            } else if (typeof dmRaw === "object" && dmRaw !== null && dmRaw.id) {
              // Build shipping method cache if not already loaded
              if (!_smCache) {
                const tmpSmCache: Record<string, string> = {};
                try {
                  const smUrl = new URL(`${baseUrl}/api/v1/shippingMethods`);
                  const smResp = await fetchWithTimeout(smUrl.toString(), { headers }, 8_000);
                  if (smResp.ok) {
                    const smData = (await smResp.json()) as { data?: Array<Record<string, unknown>>; extra?: { totalCount?: number; page?: { number?: number; size?: number } } };
                    const smPageSize = smData?.extra?.page?.size ?? 10;
                    const smTotalCount = smData?.extra?.totalCount ?? 0;
                    const smTotalPages = Math.ceil(smTotalCount / smPageSize);
                    for (const sm of smData?.data ?? []) {
                      const smId = String(sm.id ?? "");
                      const smName = String(sm.designation ?? sm.name ?? "").trim();
                      if (smId && smName) tmpSmCache[smId] = smName;
                    }
                    // Fetch remaining pages
                    for (let p = 2; p <= smTotalPages; p++) {
                      const smPUrl = new URL(`${baseUrl}/api/v1/shippingMethods`);
                      smPUrl.searchParams.set("page[number]", String(p));
                      smPUrl.searchParams.set("page[size]", String(smPageSize));
                      const smPResp = await fetchWithTimeout(smPUrl.toString(), { headers }, 5_000);
                      if (!smPResp.ok) break;
                      const smPData = (await smPResp.json()) as { data?: Array<Record<string, unknown>> };
                      for (const sm of smPData?.data ?? []) {
                        const smId = String(sm.id ?? "");
                        const smName = String(sm.designation ?? sm.name ?? "").trim();
                        if (smId && smName) tmpSmCache[smId] = smName;
                      }
                    }
                    _smCache = tmpSmCache;
                  }
                } catch (e) { console.log(`[Poller] SM V1 exception: ${e}`); }
              }
              deliveryMethod = _smCache?.[String(dmRaw.id)] ?? `ID:${dmRaw.id}`;
            } else if (typeof dmRaw === "string") {
              deliveryMethod = dmRaw.trim() || undefined;
            }
            // Line items for price extraction
            salesOrderLineItems = ((so.lineItems as unknown[]) ?? []) as Array<Record<string, unknown>>;
            console.log(`[Poller] Sales order ${salesOrderId}: payment=${paymentMethod ?? "n/a"}, delivery=${deliveryMethod ?? "n/a"}, items=${salesOrderLineItems.length}`);
          }
        } catch {
          console.log(`[Poller] Could not fetch sales order ${salesOrderId} — payment/delivery will be missing`);
        }
      }
      // Build a price lookup from sales order line items (keyed by product number)
      // Xentral V3 price structure: { net: { amount: "4.50000000", currency: "EUR" }, gross: { ... } }
      const soPriceMap = new Map<string, { amount: number; currency: string }>();
      for (const soItem of salesOrderLineItems) {
        // Product number is directly on the line item (not nested under product)
        const soItemNum = String(soItem.number ?? (soItem.product as Record<string, unknown> | undefined)?.number ?? "");
        const priceObj = soItem.price as Record<string, unknown> | undefined;
        const netObj = priceObj?.net as Record<string, unknown> | undefined;
        const grossObj = priceObj?.gross as Record<string, unknown> | undefined;
        // Prefer net amount; fall back to gross; fall back to flat unitPrice
        const rawAmount = netObj?.amount ?? grossObj?.amount ?? soItem.unitPrice;
        const soCurrency = String(netObj?.currency ?? grossObj?.currency ?? soItem.currency ?? "EUR");
        if (soItemNum && rawAmount !== undefined) {
          // Replace comma with dot to handle any locale-formatted strings
          const amount = Number(String(rawAmount).replace(",", "."));
          if (!isNaN(amount)) {
            soPriceMap.set(soItemNum, { amount, currency: soCurrency });
          }
        }
      }

      const positions = lineItems
        .filter((li) => {
          const item = li as Record<string, unknown>;
          return item.type === "product";
        })
        .map((li) => {
          const item = li as Record<string, unknown>;
          const prod = item.product as Record<string, unknown> | undefined;
          const productNumber = String(item.number ?? prod?.number ?? "");
          // Try to get price from sales order line items first, then delivery note
          const soPrice = soPriceMap.get(productNumber);
          const itemPrice = item.unitPrice ?? (item.price as Record<string, unknown> | undefined)?.amount;
          const itemCurrency = String((item.price as Record<string, unknown> | undefined)?.currency ?? "EUR");
          return {
            product: {
              id: String(prod?.id ?? ""),
              number: productNumber,
              name: String(item.name ?? prod?.name ?? ""),
              ean: prod?.ean ? String(prod.ean) : undefined,
            },
            quantity: item.quantity,
            unit: item.unit,
            price: soPrice ?? (itemPrice !== undefined ? { amount: Number(itemPrice), currency: itemCurrency } : undefined),
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
        salesOrderId,
        paymentMethod,
        deliveryMethod,
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
