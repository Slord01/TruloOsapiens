import { describe, it, expect } from "vitest";
import { mapDeliveryNoteToSalesOrder } from "./dataMapper";
import { generateQrCode, estimatePayloadSize } from "./qrGenerator";
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

// ─── QR Generator Tests ───────────────────────────────────────────────────────

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

describe("generateQrCode", () => {
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
