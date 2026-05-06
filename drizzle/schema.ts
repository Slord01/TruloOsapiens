import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  json,
  decimal,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Delivery Notes ───────────────────────────────────────────────────────────

export const deliveryNotes = mysqlTable("delivery_notes", {
  id: int("id").autoincrement().primaryKey(),
  /** Xentral delivery note ID */
  xentralId: varchar("xentralId", { length: 128 }).notNull().unique(),
  /** Xentral delivery note number (human-readable, e.g. LN-2026-00123) */
  xentralNumber: varchar("xentralNumber", { length: 128 }).notNull(),
  /** Xentral customer ID */
  customerId: varchar("customerId", { length: 128 }),
  /** Customer company name */
  customerName: varchar("customerName", { length: 512 }),
  /** Customer EOID extracted from free field "EOID Number" */
  eoid: varchar("eoid", { length: 256 }),
  /** Delivery address street */
  addressStreet: varchar("addressStreet", { length: 512 }),
  /** Delivery address city */
  addressCity: varchar("addressCity", { length: 256 }),
  /** Delivery address postal code */
  addressPostalCode: varchar("addressPostalCode", { length: 32 }),
  /** Delivery address country code (ISO 3166-1 alpha-2) */
  addressCountry: varchar("addressCountry", { length: 8 }),
  /** Raw Xentral webhook payload stored for debugging */
  rawPayload: json("rawPayload"),
  /** Mapped Osapiens SalesOrder JSON (null if mapping failed) */
  osapiensSalesOrder: json("osapiensSalesOrder"),
  /** Base64-encoded QR code PNG (null if generation failed) */
  qrCodeDataUrl: text("qrCodeDataUrl"),
  /** Processing status */
  status: mysqlEnum("status", ["pending", "ready", "error"]).default("pending").notNull(),
  /** Human-readable error message if status = error */
  errorMessage: text("errorMessage"),
  /** ISO date of the delivery note from Xentral */
  deliveryDate: varchar("deliveryDate", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DeliveryNote = typeof deliveryNotes.$inferSelect;
export type InsertDeliveryNote = typeof deliveryNotes.$inferInsert;

// ─── Delivery Note Items ──────────────────────────────────────────────────────

export const deliveryNoteItems = mysqlTable("delivery_note_items", {
  id: int("id").autoincrement().primaryKey(),
  deliveryNoteId: int("deliveryNoteId").notNull(),
  /** Xentral product ID */
  productId: varchar("productId", { length: 128 }),
  /** Xentral article number / SKU */
  productNumber: varchar("productNumber", { length: 256 }),
  /** Product name */
  productName: varchar("productName", { length: 512 }),
  /** EAN / GTIN */
  ean: varchar("ean", { length: 64 }),
  /** Quantity dispatched */
  quantity: decimal("quantity", { precision: 12, scale: 3 }),
  /** Unit of measure */
  unit: varchar("unit", { length: 32 }),
  /** Net unit price */
  unitPrice: decimal("unitPrice", { precision: 12, scale: 4 }),
  /** Currency code (e.g. EUR) */
  currency: varchar("currency", { length: 8 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DeliveryNoteItem = typeof deliveryNoteItems.$inferSelect;
export type InsertDeliveryNoteItem = typeof deliveryNoteItems.$inferInsert;
