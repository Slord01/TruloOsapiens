import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDeliveryNoteByIdMock, getDbMock } = vi.hoisted(() => ({
  getDeliveryNoteByIdMock: vi.fn(),
  getDbMock: vi.fn(),
}));

vi.mock("./db", () => ({
  getDeliveryNoteById: getDeliveryNoteByIdMock,
  getDb: getDbMock,
}));

import { sendDispatchToOsapiens } from "./osapiensSender";

const note = {
  id: 123,
  xentralNumber: "LN-2026-12345",
  customerName: "Example Retail GmbH",
  eoid: "QCBDR+1DE123456",
  fid: "QCBDR<1DE123456789012",
  addressStreet: "Example Street 10",
  addressCity: "Berlin",
  addressPostalCode: "10115",
  addressCountry: "DE",
  deliveryDate: "2026-08-27",
  items: [
    { productName: "Tobacco Product", productNumber: "95001", ean: "4012345678901", quantity: "5" },
  ],
};

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendDispatchToOsapiens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getDbMock.mockResolvedValue(null); // Audit persistence is tested by integration; no DB is required here.
    getDeliveryNoteByIdMock.mockResolvedValue(note);
    process.env.OSAPIENS_API_URL = "https://prod.osapiens.cloud";
    process.env.OSAPIENS_USERNAME = "api@example.test";
    process.env.OSAPIENS_PASSWORD = "secret";
    process.env.OSAPIENS_CUSTOMER = "trulodistro";
    process.env.OSAPIENS_OUR_FID = "QCBDR<1DE538913929428";
    process.env.OSAPIENS_OUR_EOID = "QCBDR+1DE538913";
  });

  it("creates a Customer (Sold-to Party), not a customer Organisation", async () => {
    const fetchMock = vi.fn()
      // Find TRULO's existing organisation key.
      .mockResolvedValueOnce(apiResponse({
        error: false,
        data: [{ Eoid: "QCBDR+1DE538913", KEY: "trulo-org-guid" }],
      }))
      // Customer not yet created.
      .mockResolvedValueOnce(apiResponse({ error: false, data: null }))
      // Customer creation, delivery point creation, sales-order creation.
      .mockResolvedValueOnce(apiResponse({ error: false, message: "Customer created" }))
      .mockResolvedValueOnce(apiResponse({ error: false, message: "Delivery point created" }))
      .mockResolvedValueOnce(apiResponse({ error: false, message: "Sales order created" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDispatchToOsapiens(123);

    expect(result.success).toBe(true);
    const requests = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(requests.some((request) => request.object === "Organization" && request.action === "Create")).toBe(false);

    const customerCreate = requests.find((request) => request.object === "Customer" && request.action === "Create");
    expect(customerCreate).toMatchObject({
      key: "QCBDR+1DE123456",
      data: {
        Eoid: "QCBDR+1DE123456",
        Name: "Example Retail GmbH",
        OrganizationRef: "trulo-org-guid",
      },
    });

    const deliveryPointCreate = requests.find((request) => request.object === "DeliveryPoint" && request.action === "Create");
    expect(deliveryPointCreate.data).toMatchObject({
      Fid: "QCBDR<1DE123456789012",
      Eoid: "QCBDR+1DE123456",
      OrganizationRef: "trulo-org-guid",
    });

    const salesOrder = requests.find((request) => request.object === "SalesOrder");
    expect(salesOrder.data).toMatchObject({
      SoldToParty: { EoId: "QCBDR+1DE123456" },
      DeliveryPoint: { FacilityId: "QCBDR<1DE123456789012" },
      ScanningPoint: { FacilityId: "QCBDR<1DE538913929428" },
    });
  });

  it("treats BO_ALREADY_EXIST as a confirmed, idempotent SalesOrder send", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse({
        error: false,
        data: [{ Eoid: "QCBDR+1DE538913", KEY: "trulo-org-guid" }],
      }))
      // Customer already exists; no new Customer create request is required.
      .mockResolvedValueOnce(apiResponse({ error: false, data: { KEY: note.eoid } }))
      .mockResolvedValueOnce(apiResponse({ error: false, message: "Delivery point created" }))
      .mockResolvedValueOnce(apiResponse({
        error: true,
        errorCode: "BO_ALREADY_EXIST",
        message: "Sales order already exists",
      }, 400));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDispatchToOsapiens(123);

    expect(result).toMatchObject({ success: true, alreadyExisted: true, statusCode: 400 });
  });
});
