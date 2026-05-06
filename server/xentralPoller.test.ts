/**
 * Tests for xentralPoller.ts
 *
 * Verifies:
 * 1. Correct V3 API URL construction and filter syntax
 * 2. Correct handling of V1 detail fallback
 * 3. Newly-imported tracking (isNew flag)
 * 4. Error handling when Xentral API returns non-200
 * 5. Missing credentials throw immediately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("./webhookProcessor", () => ({
  processWebhookPayload: vi.fn().mockResolvedValue({ id: 1, status: "ready" }),
}));

vi.mock("./productCache", () => ({
  refreshProductCache: vi.fn().mockResolvedValue({ count: 5, error: null }),
}));

vi.mock("./db", () => ({
  getDeliveryNoteByXentralId: vi.fn().mockResolvedValue(null), // null = not in DB (new)
}));

import { fetchAndProcessDeliveryNotes } from "./xentralPoller";
import { processWebhookPayload } from "./webhookProcessor";
import { getDeliveryNoteByXentralId } from "./db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeV3ListResponse(notes: object[]) {
  return {
    ok: true,
    json: async () => ({ data: notes }),
    text: async () => "",
  };
}

function makeV1DetailResponse(note: object) {
  return {
    ok: true,
    json: async () => ({ data: note }),
    text: async () => "",
  };
}

function makeErrorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => statusText,
  };
}

const sampleV3Note = {
  id: "42",
  documentNumber: "LN-2026-00001",
  documentDate: "2026-05-06",
  createdAt: "2026-05-06T10:00:00+00:00",
  address: { id: "100" },
  documentAddress: {
    name: "Tabak GmbH",
    street: "Hauptstraße 10",
    city: "Berlin",
    zipCode: "10115",
    country: "DE",
  },
};

const sampleV1Detail = {
  id: "42",
  number: "LN-2026-00001",
  date: "2026-05-06",
  customer: {
    id: "100",
    companyName: "Tabak GmbH",
    address: {
      street: "Hauptstraße 10",
      city: "Berlin",
      zipCode: "10115",
      countryCode: "DE",
    },
    freeFields: [{ name: "EOID Number", value: "DE12345678901234" }],
  },
  positions: [
    {
      id: "pos-1",
      product: { id: "prod-001", number: "TAB-001", name: "Cigarettes", ean: "4012345678901" },
      quantity: 50,
      unit: "Stk",
      price: { amount: 6.5, currency: "EUR" },
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("fetchAndProcessDeliveryNotes", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      XENTRAL_BASE_URL: "https://my-company.xentral.biz",
      XENTRAL_API_KEY: "test-api-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws immediately when credentials are missing", async () => {
    delete process.env.XENTRAL_BASE_URL;
    delete process.env.XENTRAL_API_KEY;

    await expect(fetchAndProcessDeliveryNotes()).rejects.toThrow(
      "XENTRAL_BASE_URL and XENTRAL_API_KEY must be set"
    );
  });

  it("calls the V3 deliveryNotes endpoint with correct filter syntax", async () => {
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValue(null);
    vi.mocked(processWebhookPayload).mockResolvedValue({ id: 1, status: "ready" });

    let capturedUrl = "";
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v3/deliveryNotes") && !urlStr.includes("/42")) {
        capturedUrl = urlStr;
        return makeV3ListResponse([sampleV3Note]) as unknown as Response;
      }
      if (urlStr.includes("/api/v1/deliverynotes/42")) {
        return makeV1DetailResponse(sampleV1Detail) as unknown as Response;
      }
      return makeErrorResponse(404, "Not Found") as unknown as Response;
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(fetchMock).toHaveBeenCalled();
    expect(result.fetched).toBe(1);
    // Verify the V3 filter parameters are correctly encoded in the URL
    expect(capturedUrl).toContain("filter%5B0%5D%5Bkey%5D=createdAt");
    expect(capturedUrl).toContain("filter%5B0%5D%5Bop%5D=greaterThanOrEquals");
    expect(capturedUrl).toContain("perPage=100");
  });

  it("counts newly imported records correctly (isNew = true when not in DB)", async () => {
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValue(null); // not in DB
    vi.mocked(processWebhookPayload).mockResolvedValue({ id: 1, status: "ready" });

    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v3/deliveryNotes") && !urlStr.includes("/42")) {
        return makeV3ListResponse([sampleV3Note]) as unknown as Response;
      }
      if (urlStr.includes("/api/v1/deliverynotes/42")) {
        return makeV1DetailResponse(sampleV1Detail) as unknown as Response;
      }
      return makeErrorResponse(404, "Not Found") as unknown as Response;
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result.imported).toBe(1); // newly inserted
    expect(result.errors).toBe(0);
    expect(result.details[0].isNew).toBe(true);
  });

  it("does NOT increment imported for already-existing records", async () => {
    // Simulate record already in DB
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValue({ id: 1 } as never);
    vi.mocked(processWebhookPayload).mockResolvedValue({ id: 1, status: "ready" });

    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v3/deliveryNotes") && !urlStr.includes("/42")) {
        return makeV3ListResponse([sampleV3Note]) as unknown as Response;
      }
      if (urlStr.includes("/api/v1/deliverynotes/42")) {
        return makeV1DetailResponse(sampleV1Detail) as unknown as Response;
      }
      return makeErrorResponse(404, "Not Found") as unknown as Response;
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result.imported).toBe(0); // already existed — not counted as new
    expect(result.fetched).toBe(1);
    expect(result.details[0].isNew).toBe(false);
  });

  it("returns zero fetched when Xentral returns an empty list", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v3/deliveryNotes")) {
        return makeV3ListResponse([]) as unknown as Response;
      }
      return makeErrorResponse(404, "Not Found") as unknown as Response;
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result.fetched).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("throws when the V3 list endpoint returns a non-200 status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeErrorResponse(401, "Unauthorized") as unknown as Response
    );

    await expect(fetchAndProcessDeliveryNotes(7)).rejects.toThrow("401");
  });

  it("counts errors when processWebhookPayload throws", async () => {
    vi.mocked(getDeliveryNoteByXentralId).mockResolvedValue(null);
    vi.mocked(processWebhookPayload).mockRejectedValue(new Error("Mapping failed"));

    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/v3/deliveryNotes") && !urlStr.includes("/42")) {
        return makeV3ListResponse([sampleV3Note]) as unknown as Response;
      }
      if (urlStr.includes("/api/v1/deliverynotes/42")) {
        return makeV1DetailResponse(sampleV1Detail) as unknown as Response;
      }
      return makeErrorResponse(404, "Not Found") as unknown as Response;
    });

    const result = await fetchAndProcessDeliveryNotes(7);

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.details[0].error).toContain("Mapping failed");
  });
});
