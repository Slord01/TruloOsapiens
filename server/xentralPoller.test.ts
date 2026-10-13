import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./webhookProcessor", () => ({
  processWebhookPayload: vi.fn().mockResolvedValue({ id: 1, status: "ready" }),
}));

vi.mock("./productCache", () => ({
  refreshProductCache: vi.fn().mockResolvedValue({ count: 5, error: null }),
  isTobaccoProduct: (_id: string) => false,
  isTobaccoProductNumber: (number: string) => number.startsWith("95"),
}));

vi.mock("./db", () => ({
  getDeliveryNoteByXentralId: vi.fn().mockResolvedValue(null),
  getDeliveryNoteBySalesOrderId: vi.fn().mockResolvedValue(null),
  updateSalesOrderNumberBySalesOrderId: vi.fn().mockResolvedValue(undefined),
}));

import { processWebhookPayload } from "./webhookProcessor";
import {
  getDeliveryNoteBySalesOrderId,
  getDeliveryNoteByXentralId,
  updateSalesOrderNumberBySalesOrderId,
} from "./db";
import {
  fetchAndProcessDeliveryNotes,
  fetchDeliveryNoteByDocumentNumber,
} from "./xentralPoller";

function response(data: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ data }),
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => statusText,
  } as unknown as Response;
}

function tobaccoDocument(id: string, documentNumber: string) {
  return {
    id,
    documentNumber,
    documentDate: "2026-10-12",
    createdAt: "2026-10-12T12:32:31+02:00",
    status: "completed",
    documentAddress: {
      name: "Tobacco Shop GmbH",
      street: "Hauptstraße 10",
      city: "Berlin",
      zipCode: "10115",
      country: "DE",
    },
    address: { id: "100" },
    lineItems: [
      {
        type: "product",
        number: "95005",
        name: "Tobacco product",
        quantity: 20,
        unit: "PCE",
        product: { id: "product-95005", number: "95005", name: "Tobacco product" },
      },
    ],
  };
}

function fetchMockFor(options: {
  deliveryLists?: Record<string, object[]>;
  salesLists?: Record<string, object[]>;
  detailById?: Record<string, object>;
}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const page = url.searchParams.get("page") ?? "1";
    const detailId = path.split("/").at(-1) ?? "";

    if (path === "/api/v3/deliveryNotes") {
      return response(options.deliveryLists?.[page] ?? []);
    }
    if (path === "/api/v3/salesOrders") {
      return response(options.salesLists?.[page] ?? []);
    }
    if (path.startsWith("/api/v3/deliveryNotes/")) {
      return response(options.detailById?.[detailId] ?? tobaccoDocument(detailId, detailId));
    }
    if (path.startsWith("/api/v3/salesOrders/")) {
      return response(options.detailById?.[detailId] ?? tobaccoDocument(detailId, detailId));
    }
    if (path.startsWith("/api/v1/adressen/")) {
      return response({ freifeld5: "QCBDR+1DE123456", freifeld6: "QCBDR<1DE123456789012" });
    }
    return errorResponse(404, "Not Found");
  });
}

describe("Xentral order importer", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      XENTRAL_API_URL: "https://my-company.xentral.biz",
      XENTRAL_API_KEY: "test-api-key",
    };
    vi.mocked(processWebhookPayload).mockResolvedValue({ id: 1, status: "ready" });
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValue(null);
    vi.mocked(getDeliveryNoteBySalesOrderId).mockResolvedValue(null);
    vi.mocked(updateSalesOrderNumberBySalesOrderId).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("requires Xentral credentials", async () => {
    delete process.env.XENTRAL_API_URL;
    delete process.env.XENTRAL_API_KEY;

    await expect(fetchAndProcessDeliveryNotes()).rejects.toThrow(
      "XENTRAL_API_URL and XENTRAL_API_KEY must be set"
    );
  });

  it("follows all delivery-note pages instead of stopping at the first 100 records", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      tobaccoDocument(`delivery-${index + 1}`, `DN-${index + 1}`)
    );
    const finalPage = tobaccoDocument("delivery-101", "DN-101");
    const fetchMock = fetchMockFor({
      deliveryLists: { "1": firstPage, "2": [finalPage] },
      salesLists: { "1": [] },
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result.fetched).toBe(101);
    expect(result.imported).toBe(101);
    const listUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/api/v3/deliveryNotes?") || url.includes("/api/v3/salesOrders?"));
    expect(listUrls.some((url) => url.includes("deliveryNotes") && url.includes("page=2"))).toBe(true);
    expect(listUrls.every((url) => url.includes("lineItems.number") || url.includes("lineItems%2Enumber"))).toBe(true);
  });

  it("imports completed tobacco sales order 621314 when no delivery note exists", async () => {
    const salesOrder = tobaccoDocument("501522", "621314");
    const fetchMock = fetchMockFor({
      deliveryLists: { "1": [] },
      salesLists: { "1": [salesOrder] },
      detailById: { "501522": salesOrder },
    });

    const result = await fetchDeliveryNoteByDocumentNumber("621314");

    expect(result).toMatchObject({ fetched: 1, tobaccoFound: 1, imported: 1, errors: 0 });
    expect(processWebhookPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sales-order-501522",
        documentNumber: "621314",
        salesOrderId: "501522",
        salesOrderNumber: "621314",
      })
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/v3/salesOrders/501522"))).toBe(true);
  });

  it("does not import an incomplete sales order before dispatch is eligible", async () => {
    const uncompletedSalesOrder = { ...tobaccoDocument("501523", "621315"), status: "released" };
    fetchMockFor({ deliveryLists: { "1": [] }, salesLists: { "1": [uncompletedSalesOrder] } });

    const result = await fetchDeliveryNoteByDocumentNumber("621315");

    expect(result).toMatchObject({ fetched: 1, imported: 0, tobaccoFound: 0, skipped: 1 });
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it("backfills the linked sales-order number for an existing ready delivery note", async () => {
    const deliveryNote = {
      id: "232124",
      documentNumber: "463288",
      salesOrder: { id: "501522" },
    };
    const linkedSalesOrder = tobaccoDocument("501522", "621314");
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValueOnce({
      id: 690001,
      status: "ready",
      salesOrderNumber: null,
    } as never);
    fetchMockFor({
      deliveryLists: { "1": [deliveryNote] },
      salesLists: { "1": [] },
      detailById: { "501522": linkedSalesOrder },
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result).toMatchObject({ fetched: 1, imported: 0, skipped: 1 });
    expect(updateSalesOrderNumberBySalesOrderId).toHaveBeenCalledWith("501522", "621314");
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it("backfills an existing delivery-note row when searched directly by sales-order number", async () => {
    const salesOrder = tobaccoDocument("501522", "621314");
    vi.mocked(getDeliveryNoteBySalesOrderId).mockResolvedValueOnce({
      id: 690001,
      status: "ready",
      salesOrderNumber: null,
    } as never);
    fetchMockFor({ deliveryLists: { "1": [] }, salesLists: { "1": [salesOrder] } });

    const result = await fetchDeliveryNoteByDocumentNumber("621314");

    expect(result).toMatchObject({ fetched: 1, imported: 0, skipped: 1 });
    expect(updateSalesOrderNumberBySalesOrderId).toHaveBeenCalledWith("501522", "621314");
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it("returns the upstream list error with its status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(errorResponse(401, "Unauthorized"));

    await expect(fetchAndProcessDeliveryNotes(7)).rejects.toThrow("401");
  });

  it("counts processing failures without failing other records", async () => {
    vi.mocked(processWebhookPayload).mockRejectedValue(new Error("Mapping failed"));
    fetchMockFor({
      deliveryLists: { "1": [tobaccoDocument("delivery-1", "DN-1")] },
      salesLists: { "1": [] },
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result).toMatchObject({ fetched: 1, imported: 0, errors: 1 });
    expect(result.details[0]?.error).toContain("Mapping failed");
  });
});
