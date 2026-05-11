import { describe, it, expect } from "vitest";
import { mapDeliveryNoteToSalesOrder } from "./dataMapper";
import {
  generateQrCode,
  estimatePayloadSize,
  generateDispatchQrCode,
  buildDispatchQrText,
  estimateDispatchPayloadSize,
  type DispatchQrParams,
} from "./qrGenerator";
import type { OsapiensSalesOrder } from "./dataMapper";

// ─── Shared test fixture ──────────────────────────────────────────────────────

const basePayload = {
  id: "dn-001",
  number: "LN-2026-00123",
  date: "2026-05-06",
  customer: {
    id: "cust-42",
    name: "Tabak GmbH",
    companyName: "Tabak GmbH",
    address: {
      street: "Hauptstraße 10",
      city: "Berlin",
      zipCode: "10115",
      countryCode: "DE",
    },
    freeFields: [{ name: "EOID Nummer", value: "DE12345678901234" }],
    fid: "OSAP-FID-001",
  },
  positions: [
    {
      id: "pos-1",
      product: { id: "prod-001", number: "TAB-001", name: "Premium Cigarettes 20pk", ean: "4012345678901" },
      quantity: 50,
      unit: "Stk",
      price: { amount: 6.5, currency: "EUR" },
    },
    {
      id: "pos-2",
      product: { id: "prod-002", number: "TAB-002", name: "Rolling Tobacco 50g", ean: "4012345678902" },
      quantity: 20,
      unit: "Stk",
      price: { amount: 12.0, currency: "EUR" },
    },
  ],
};

const tobaccoPositions = basePayload.positions;

// ─── Data Mapper Tests ────────────────────────────────────────────────────────

describe("mapDeliveryNoteToSalesOrder", () => {
  it("maps a valid payload to the Osapiens SalesOrder schema", () => {
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, tobaccoPositions as any);
    expect(result.success).toBe(true);
    expect(result.salesOrder).toBeDefined();
    const so = result.salesOrder!;
    expect(so.orderNumber).toBe("LN-2026-00123");
    expect(so.customer.eoid).toBe("DE12345678901234");
    expect(so.customer.name).toBe("Tabak GmbH");
    expect(so.customer.address.street).toBe("Hauptstraße 10");
    expect(so.customer.address.city).toBe("Berlin");
    expect(so.customer.address.postalCode).toBe("10115");
    expect(so.customer.address.country).toBe("DE");
    expect(so.items).toHaveLength(2);
    expect(so.items[0].productNumber).toBe("TAB-001");
    expect(so.items[0].quantity).toBe(50);
    expect(so.items[0].ean).toBe("4012345678901");
    expect(so.items[1].productNumber).toBe("TAB-002");
  });

  it("extracts FID from customer.fid field", () => {
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, tobaccoPositions as any);
    expect(result.success).toBe(true);
    expect(result.fid).toBe("OSAP-FID-001");
  });

  it("returns undefined fid when customer.fid is not set", () => {
    const payloadNoFid = {
      ...basePayload,
      customer: { ...basePayload.customer, fid: undefined },
    };
    const result = mapDeliveryNoteToSalesOrder(payloadNoFid as any, tobaccoPositions as any);
    expect(result.fid).toBeUndefined();
  });

  it("filters out non-tobacco products when only one is passed", () => {
    const onlyFirst = [tobaccoPositions[0]] as any;
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, onlyFirst);
    expect(result.success).toBe(true);
    expect(result.salesOrder!.items).toHaveLength(1);
    expect(result.salesOrder!.items[0].productNumber).toBe("TAB-001");
  });

  it("returns error status when EOID Number is missing", () => {
    const payloadNoEoid = {
      ...basePayload,
      customer: { ...basePayload.customer, freeFields: [] },
    };
    const result = mapDeliveryNoteToSalesOrder(payloadNoEoid as any, tobaccoPositions as any);
    expect(result.success).toBe(false);
    expect(result.missingFields).toContain("EOID Nummer");
    expect(result.errorMessage).toContain("EOID Nummer");
    expect(result.salesOrder).toBeUndefined();
  });

  it("returns error status when no tobacco products remain after filtering", () => {
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, []);
    expect(result.success).toBe(false);
    expect(result.missingFields).toContain("Tobacco Product Items");
    expect(result.salesOrder).toBeUndefined();
  });

  it("returns error status when customer name is missing", () => {
    const payloadNoName = {
      ...basePayload,
      customer: { ...basePayload.customer, name: "", companyName: "" },
    };
    const result = mapDeliveryNoteToSalesOrder(payloadNoName as any, tobaccoPositions as any);
    expect(result.success).toBe(false);
    expect(result.missingFields).toContain("Customer Name");
  });

  it("includes unit price and currency in mapped items", () => {
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, tobaccoPositions as any);
    expect(result.salesOrder!.items[0].unitPrice).toBe(6.5);
    expect(result.salesOrder!.items[0].currency).toBe("EUR");
  });

  it("error message follows the required pattern", () => {
    const payloadNoEoid = {
      ...basePayload,
      customer: { ...basePayload.customer, freeFields: [] },
    };
    const result = mapDeliveryNoteToSalesOrder(payloadNoEoid as any, tobaccoPositions as any);
    expect(result.errorMessage).toBe(
      "Missing EOID Nummer — please update the customer record in Xentral"
    );
  });

  it("extracts flat fields for DB storage", () => {
    const result = mapDeliveryNoteToSalesOrder(basePayload as any, tobaccoPositions as any);
    expect(result.eoid).toBe("DE12345678901234");
    expect(result.customerName).toBe("Tabak GmbH");
    expect(result.addressCity).toBe("Berlin");
    expect(result.addressPostalCode).toBe("10115");
    expect(result.addressCountry).toBe("DE");
  });
});

// ─── Dispatch QR Generator Tests ─────────────────────────────────────────────

const sampleDispatchParams: DispatchQrParams = {
  eoid: "DE12345678901234",
  fid: "OSAP-FID-001",
  eventTime: new Date("2025-04-28T15:30:00.000Z"),
  destinationType: 2,
  transportMode: 3,
  transportVehicle: "MA FH 42",
  products: [
    { gtin: "4012345678901", quantity: 50 },
    { gtin: "4012345678902", quantity: 20 },
  ],
};

describe("buildDispatchQrText", () => {
  it("produces OSAPV1EDP semicolon-delimited plain text", () => {
    const text = buildDispatchQrText(sampleDispatchParams);
    expect(text).toMatch(/^OSAPV1EDP;/);
    const fields = text.split(";");
    expect(fields[0]).toBe("OSAPV1EDP");
    expect(fields[1]).toBe("DE12345678901234");   // EOID
    expect(fields[3]).toBe("2");                   // destination type
    expect(fields[4]).toBe("OSAP-FID-001");        // FID
    expect(fields[5]).toBe("3");                   // transport mode
    expect(fields[6]).toBe("MA FH 42");            // vehicle
    expect(fields[12]).toBe("FALSE");              // auto arrival
    expect(fields[15]).toBe("0");                  // product count (always 0)
    expect(fields[16]).toBe("4012345678901");      // GTIN 1
    expect(fields[17]).toBe("50");                 // qty 1
    expect(fields[18]).toBe("4012345678902");      // GTIN 2
    expect(fields[19]).toBe("20");                 // qty 2
  });

  it("has exactly 20 fields for 2 products (16 base + 2*2 product pairs)", () => {
    const text = buildDispatchQrText(sampleDispatchParams);
    const fields = text.split(";");
    expect(fields).toHaveLength(20);
  });

  it("has exactly 18 fields for 1 product (16 base + 1*2 product pair)", () => {
    const params = { ...sampleDispatchParams, products: [{ gtin: "4012345678901", quantity: 50 }] };
    const text = buildDispatchQrText(params);
    const fields = text.split(";");
    expect(fields).toHaveLength(18);
  });

  it("empty optional fields produce empty semicolons", () => {
    const params: DispatchQrParams = {
      eoid: "TEST-EOID",
      fid: "TEST-FID",
      products: [{ gtin: "1234567890123", quantity: 10 }],
    };
    const text = buildDispatchQrText(params);
    const fields = text.split(";");
    // Fields 7-11 (SSCC, tracking, EMCS, SAAD, MRN) should be empty
    expect(fields[7]).toBe("");
    expect(fields[8]).toBe("");
    expect(fields[9]).toBe("");
    expect(fields[10]).toBe("");
    expect(fields[11]).toBe("");
  });

  it("matches the example from the Osapiens Excel tool", () => {
    // Example: OSAPV1EDP;Kostas1;2025-04-28T15:30:00+01:00;2;OSAP-FID-001;2;MA FH 42;Some SSCC;Some Tracking Number;Some EMCS;Some SAAD;Some MRN;FALSE;;;0;05201222501312;4
    const params: DispatchQrParams = {
      eoid: "Kostas1",
      fid: "OSAP-FID-001",
      destinationType: 2,
      transportMode: 2,
      transportVehicle: "MA FH 42",
      sscc: "Some SSCC",
      trackingNumber: "Some Tracking Number",
      emcs: "Some EMCS",
      saad: "Some SAAD",
      mrn: "Some MRN",
      products: [{ gtin: "05201222501312", quantity: 4 }],
    };
    const text = buildDispatchQrText(params);
    const fields = text.split(";");
    expect(fields[0]).toBe("OSAPV1EDP");
    expect(fields[1]).toBe("Kostas1");
    expect(fields[4]).toBe("OSAP-FID-001");
    expect(fields[5]).toBe("2");
    expect(fields[6]).toBe("MA FH 42");
    expect(fields[7]).toBe("Some SSCC");
    expect(fields[8]).toBe("Some Tracking Number");
    expect(fields[9]).toBe("Some EMCS");
    expect(fields[10]).toBe("Some SAAD");
    expect(fields[11]).toBe("Some MRN");
    expect(fields[12]).toBe("FALSE");
    expect(fields[15]).toBe("0");
    expect(fields[16]).toBe("05201222501312");
    expect(fields[17]).toBe("4");
  });

  it("dispatch payload size stays within QR code limits for 10 products", () => {
    const params: DispatchQrParams = {
      eoid: "DE12345678901234",
      fid: "OSAP-FID-001",
      products: Array.from({ length: 10 }, (_, i) => ({
        gtin: `401234567890${i}`,
        quantity: 50,
      })),
    };
    const size = estimateDispatchPayloadSize(params);
    expect(size).toBeLessThan(2953);
  });
});

describe("generateDispatchQrCode", () => {
  it("generates a base64 PNG data URL and plain text", async () => {
    const result = await generateDispatchQrCode(sampleDispatchParams);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.plainText).toMatch(/^OSAPV1EDP;/);
  });

  it("plain text in result matches buildDispatchQrText output", async () => {
    const result = await generateDispatchQrCode(sampleDispatchParams);
    const expected = buildDispatchQrText(sampleDispatchParams);
    expect(result.plainText).toBe(expected);
  });
});

// ─── Legacy QR Generator Tests (kept for backward compatibility) ──────────────

const sampleSalesOrder: OsapiensSalesOrder = {
  object: "SalesOrder",
  action: "Create",
  orderNumber: "LN-2026-00123",
  creationDate: "2026-05-06",
  customer: {
    eoid: "DE12345678901234",
    name: "Tabak GmbH",
    address: { street: "Hauptstraße 10", city: "Berlin", postalCode: "10115", country: "DE" },
  },
  items: [
    { productNumber: "TAB-001", productName: "Premium Cigarettes 20pk", ean: "4012345678901", quantity: 50, unit: "Stk", unitPrice: 6.5, currency: "EUR" },
  ],
};

describe("generateQrCode (legacy)", () => {
  it("generates a base64 PNG data URL", async () => {
    const dataUrl = await generateQrCode(sampleSalesOrder);
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("payload size stays within QR code limits for a 10-item order", () => {
    const bigOrder: OsapiensSalesOrder = {
      ...sampleSalesOrder,
      items: Array.from({ length: 10 }, (_, i) => ({
        productNumber: `TAB-00${i + 1}`,
        productName: `Tobacco Product ${i + 1}`,
        ean: `401234567890${i}`,
        quantity: 50,
        unit: "Stk",
        unitPrice: 6.5,
        currency: "EUR",
      })),
    };
    const size = estimatePayloadSize(bigOrder);
    // QR code absolute maximum is 2953 bytes
    expect(size).toBeLessThan(2953);
  });
});

// ─── Auth Logout (keep existing test passing) ─────────────────────────────────

import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): {
  ctx: TrpcContext;
  clearedCookies: { name: string; options: Record<string, unknown> }[];
} {
  const clearedCookies: { name: string; options: Record<string, unknown> }[] = [];
  const user: AuthenticatedUser = {
    id: 1,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };
  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });
});
