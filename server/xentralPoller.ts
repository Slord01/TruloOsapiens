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
import {
  getDeliveryNoteBySalesOrderId,
  getDeliveryNoteByXentralId,
  updateSalesOrderNumberBySalesOrderId,
} from "./db";

/** Module-level cache for payment method names — populated once per server session */
let _pmCache: Record<string, string> | null = null;
/** Module-level cache for shipping method names — populated once per server session */
let _smCache: Record<string, string> | null = null;

type XentralDocumentSource = "deliveryNote" | "salesOrder";

const XENTRAL_PAGE_SIZE = 100;
const POLLER_SOURCE_KEY = "__tntSource";

function endpointFor(source: XentralDocumentSource) {
  return source === "salesOrder" ? "salesOrders" : "deliveryNotes";
}

function storedXentralId(source: XentralDocumentSource, xentralId: string) {
  // DeliveryNote and SalesOrder IDs are allocated from separate Xentral tables.
  // Prefix SalesOrder IDs so the local unique key cannot collide with a delivery-note ID.
  return source === "salesOrder" ? `sales-order-${xentralId}` : xentralId;
}

function sourceFor(note: Record<string, unknown>): XentralDocumentSource {
  return note[POLLER_SOURCE_KEY] === "salesOrder" ? "salesOrder" : "deliveryNote";
}

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
  headers: Record<string, string>,
  source: XentralDocumentSource = "deliveryNote"
): Promise<Record<string, unknown>> {
  // V3 detail includes lineItems with product IDs — primary source.
  // Completed SalesOrders are also valid import sources when no delivery note
  // exists yet (for example, Xentral sales order 621314).
  // include[]=lineItems is required; without it Xentral omits the array entirely
  try {
    const detailUrl = new URL(`${baseUrl}/api/v3/${endpointFor(source)}/${id}`);
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

      const isSalesOrder = source === "salesOrder";
      // Remap V3 lineItems → positions shape expected by dataMapper
      const lineItems = (v3Note.lineItems as unknown[]) ?? [];
      // Extract sales order reference — id for API lookup, documentNumber for display
      const salesOrderRef = isSalesOrder
        ? v3Note
        : v3Note.salesOrder as Record<string, unknown> | undefined;
      let salesOrderNumber = String(
        salesOrderRef?.documentNumber ?? salesOrderRef?.number ?? ""
      ) || undefined;
      const salesOrderId = String(salesOrderRef?.id ?? "") || undefined;

      // Fetch sales order details for payment method, delivery method, and item prices
      let paymentMethod: string | undefined;
      let deliveryMethod: string | undefined;
      let salesOrderLineItems: Array<Record<string, unknown>> = [];
      if (salesOrderId) {
        try {
          let so: Record<string, unknown> | undefined;
          if (isSalesOrder) {
            so = v3Note;
          } else {
            const soUrl = new URL(`${baseUrl}/api/v3/salesOrders/${salesOrderId}`);
            soUrl.searchParams.set("include[0]", "lineItems");
            const soResp = await fetchWithTimeout(soUrl.toString(), { headers }, 8_000);
            if (soResp.ok) {
              const soData = (await soResp.json()) as { data?: Record<string, unknown> };
              so = soData?.data ?? soData as Record<string, unknown>;
            }
          }
          if (so) {
            salesOrderNumber = String(
              so.documentNumber ?? so.number ?? salesOrderNumber ?? ""
            ) || undefined;
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
        [POLLER_SOURCE_KEY]: source,
        id: storedXentralId(source, String(v3Note.id ?? id)),
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
    [POLLER_SOURCE_KEY]: source,
    id: storedXentralId(source, String(listNote.id ?? id)),
    documentNumber: listNote.documentNumber ?? listNote.number,
    number: listNote.documentNumber ?? listNote.number,
    date: listNote.documentDate ?? listNote.date,
  };
}

function createPollResult(): PollResult {
  return { fetched: 0, tobaccoFound: 0, imported: 0, errors: 0, skipped: 0, details: [] };
}

function addTobaccoFilter(url: URL, index: number) {
  // Tobacco article numbers are maintained under the 95 prefix in Xentral.
  // Filtering in Xentral keeps a multi-page sync within the API rate limit.
  url.searchParams.set(`filter[${index}][key]`, "lineItems.number");
  url.searchParams.set(`filter[${index}][op]`, "startsWith");
  url.searchParams.set(`filter[${index}][value]`, "95");
}

async function listDocuments(
  baseUrl: string,
  headers: Record<string, string>,
  source: XentralDocumentSource,
  filters: Array<{ key: string; op: string; value: string }>
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let page = 1;

  while (true) {
    const url = new URL(`${baseUrl}/api/v3/${endpointFor(source)}`);
    filters.forEach((filter, index) => {
      url.searchParams.set(`filter[${index}][key]`, filter.key);
      url.searchParams.set(`filter[${index}][op]`, filter.op);
      url.searchParams.set(`filter[${index}][value]`, filter.value);
    });
    addTobaccoFilter(url, filters.length);
    url.searchParams.set("sort", "-createdAt");
    url.searchParams.set("perPage", String(XENTRAL_PAGE_SIZE));
    url.searchParams.set("page", String(page));

    const response = await fetchWithTimeout(url.toString(), { headers }, 15_000);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Xentral API error ${response.status} ${response.statusText} while listing ${endpointFor(source)} — ${body.slice(0, 300)}`
      );
    }

    const payload = (await response.json()) as { data?: unknown[] };
    const pageRecords = (payload?.data ?? []) as Record<string, unknown>[];
    collected.push(...pageRecords.map((record) => ({ ...record, [POLLER_SOURCE_KEY]: source })));

    // V3 reports the current page but not the total record count. A short page
    // is therefore the authoritative end-of-list signal.
    if (pageRecords.length < XENTRAL_PAGE_SIZE) break;
    page++;
  }

  return collected;
}

function containsTobacco(positions: Array<Record<string, unknown>>) {
  return positions.some((pos) => {
    const product = pos.product as Record<string, unknown> | undefined;
    const productNumber = String(product?.number ?? "");
    if (productNumber && isTobaccoProductNumber(productNumber)) return true;
    const productId = String(product?.id ?? "");
    return Boolean(productId && isTobaccoProduct(productId));
  });
}

async function processDocuments(
  rawDocuments: Record<string, unknown>[],
  baseUrl: string,
  headers: Record<string, string>,
  result: PollResult
) {
  const CONCURRENCY = 5;

  async function processOne(note: Record<string, unknown>) {
    const source = sourceFor(note);
    const nativeId = String(note.id ?? "");
    const localId = storedXentralId(source, nativeId);
    const number = String(note.documentNumber ?? note.number ?? nativeId);

    // Delivery notes are dispatched documents by definition. SalesOrders are a
    // fallback for the operations team and become eligible only once Xentral
    // reports them as completed; this avoids issuing a dispatch QR early.
    if (source === "salesOrder" && String(note.status ?? "").toLowerCase() !== "completed") {
      result.skipped++;
      return;
    }

    let existing = await getDeliveryNoteByXentralId(localId).catch(() => null);

    // A SalesOrder import is the pre-delivery fallback. Do not create a second
    // local record when the same SalesOrder already has a ready/sent record.
    const relatedSalesOrderId = source === "deliveryNote"
      ? String((note.salesOrder as Record<string, unknown> | undefined)?.id ?? "")
      : nativeId;
    if (!existing && relatedSalesOrderId) {
      existing = await getDeliveryNoteBySalesOrderId(relatedSalesOrderId).catch(() => null);
    }

    if (existing?.status === "ready" || existing?.status === "sent") {
      // Resolve or retain the human-facing sales-order number so an existing
      // delivery-note row is searchable by the number operations uses.
      if (relatedSalesOrderId && !existing.salesOrderNumber) {
        try {
          let salesOrderNumber = source === "salesOrder" ? number : "";
          if (!salesOrderNumber) {
            const linkedSalesOrder = await fetchNoteDetail(
              baseUrl,
              relatedSalesOrderId,
              { id: relatedSalesOrderId },
              headers,
              "salesOrder"
            );
            salesOrderNumber = String(linkedSalesOrder.salesOrderNumber ?? "");
          }
          if (salesOrderNumber) {
            await updateSalesOrderNumberBySalesOrderId(relatedSalesOrderId, salesOrderNumber);
          }
        } catch (error) {
          console.warn(`[Poller] Could not backfill sales order number ${relatedSalesOrderId}:`, error);
        }
      }
      result.skipped++;
      result.details.push({ id: nativeId, number, status: existing.status, isNew: false });
      return;
    }

    try {
      const fullDocument = await fetchNoteDetail(baseUrl, nativeId, note, headers, source);
      const positions = (fullDocument.positions as Array<Record<string, unknown>>) ?? [];
      if (!containsTobacco(positions)) {
        result.skipped++;
        return;
      }

      result.tobaccoFound++;
      const processed = await processWebhookPayload(fullDocument);
      const isNew = !existing;
      result.details.push({ id: nativeId, number, status: processed.status, isNew });

      if (processed.status === "ready") {
        if (isNew) result.imported++;
      } else if (processed.status === "error") {
        result.errors++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.details.push({ id: nativeId, number, status: "error", isNew: !existing, error: message });
      result.errors++;
      console.error(`[Poller] Failed to process ${source} ${nativeId}:`, err);
    }
  }

  for (let start = 0; start < rawDocuments.length; start += CONCURRENCY) {
    await Promise.all(rawDocuments.slice(start, start + CONCURRENCY).map(processOne));
  }
}

function getXentralConfig() {
  const baseUrl = (process.env.XENTRAL_API_URL ?? process.env.XENTRAL_BASE_URL)?.replace(/\/$/, "");
  const apiKey = process.env.XENTRAL_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("XENTRAL_API_URL and XENTRAL_API_KEY must be set to fetch orders from Xentral");
  }
  return {
    baseUrl,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } as Record<string, string>,
  };
}

/**
 * Fetch all recent tobacco delivery notes and completed tobacco SalesOrders.
 * V3 list paging is followed until its final short page, preventing any
 * first-page (100-record) truncation.
 */
export async function fetchAndProcessDeliveryNotes(lookbackDays = 7): Promise<PollResult> {
  const { baseUrl, headers } = getXentralConfig();
  await refreshProductCache();

  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  since.setHours(0, 0, 0, 0);
  const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const recentFilter = [{ key: "createdAt", op: "greaterThanOrEquals", value: sinceStr }];

  const [deliveryNotes, salesOrders] = await Promise.all([
    listDocuments(baseUrl, headers, "deliveryNote", recentFilter),
    listDocuments(baseUrl, headers, "salesOrder", recentFilter),
  ]);

  const result = createPollResult();
  result.fetched = deliveryNotes.length + salesOrders.length;
  await processDocuments([...deliveryNotes, ...salesOrders], baseUrl, headers, result);
  return result;
}

/**
 * Fetch a tobacco delivery note or completed tobacco SalesOrder by the
 * document number shown in Xentral (for example, 621314).
 */
export async function fetchDeliveryNoteByDocumentNumber(documentNumber: string): Promise<PollResult> {
  const { baseUrl, headers } = getXentralConfig();
  await refreshProductCache();
  const exactFilter = [{ key: "documentNumber", op: "equals", value: documentNumber.trim() }];
  const [deliveryNotes, salesOrders] = await Promise.all([
    listDocuments(baseUrl, headers, "deliveryNote", exactFilter),
    listDocuments(baseUrl, headers, "salesOrder", exactFilter),
  ]);

  const result = createPollResult();
  result.fetched = deliveryNotes.length + salesOrders.length;
  await processDocuments([...deliveryNotes, ...salesOrders], baseUrl, headers, result);
  return result;
}
