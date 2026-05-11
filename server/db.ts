import { eq, desc, and, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  deliveryNotes,
  deliveryNoteItems,
  InsertDeliveryNote,
  InsertDeliveryNoteItem,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];
  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };
  textFields.forEach(assignNullable);
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Delivery Notes ───────────────────────────────────────────────────────────

export async function upsertDeliveryNote(note: InsertDeliveryNote) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(deliveryNotes)
    .values(note)
    .onDuplicateKeyUpdate({
      set: {
        xentralNumber: note.xentralNumber,
        customerId: note.customerId,
        customerName: note.customerName,
        eoid: note.eoid,
        fid: note.fid,
        salesOrderId: note.salesOrderId,
        paymentMethod: note.paymentMethod,
        deliveryMethod: note.deliveryMethod,
        orderValue: note.orderValue,
        orderCurrency: note.orderCurrency,
        addressStreet: note.addressStreet,
        addressCity: note.addressCity,
        addressPostalCode: note.addressPostalCode,
        addressCountry: note.addressCountry,
        rawPayload: note.rawPayload,
        osapiensSalesOrder: note.osapiensSalesOrder,
        qrCodeDataUrl: note.qrCodeDataUrl,
        dispatchQrText: note.dispatchQrText,
        status: note.status,
        errorMessage: note.errorMessage,
        deliveryDate: note.deliveryDate,
      },
    });
  const result = await db
    .select()
    .from(deliveryNotes)
    .where(eq(deliveryNotes.xentralId, note.xentralId))
    .limit(1);
  return result[0];
}

export async function insertDeliveryNoteItems(items: InsertDeliveryNoteItem[]) {
  const db = await getDb();
  if (!db || items.length === 0) return;
  await db.insert(deliveryNoteItems).values(items);
}

export async function deleteDeliveryNoteItems(deliveryNoteId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(deliveryNoteItems).where(eq(deliveryNoteItems.deliveryNoteId, deliveryNoteId));
}

export async function getDeliveryNoteById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const notes = await db.select().from(deliveryNotes).where(eq(deliveryNotes.id, id)).limit(1);
  if (!notes[0]) return undefined;
  const items = await db
    .select()
    .from(deliveryNoteItems)
    .where(eq(deliveryNoteItems.deliveryNoteId, id));
  return { ...notes[0], items };
}

export async function getDeliveryNoteByXentralId(xentralId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const notes = await db
    .select()
    .from(deliveryNotes)
    .where(eq(deliveryNotes.xentralId, xentralId))
    .limit(1);
  return notes[0];
}

export async function listDeliveryNotes(opts: {
  page: number;
  pageSize: number;
  status?: "pending" | "ready" | "error";
  search?: string;
}) {
  const db = await getDb();
  if (!db) return { notes: [], total: 0 };

  const conditions = [];
  if (opts.status) conditions.push(eq(deliveryNotes.status, opts.status));
  if (opts.search) {
    conditions.push(
      sql`(${deliveryNotes.xentralNumber} LIKE ${`%${opts.search}%`} OR ${deliveryNotes.customerName} LIKE ${`%${opts.search}%`})`
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [notes, countResult] = await Promise.all([
    db
      .select()
      .from(deliveryNotes)
      .where(where)
      .orderBy(desc(deliveryNotes.createdAt))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(deliveryNotes)
      .where(where),
  ]);

  return { notes, total: Number(countResult[0]?.count ?? 0) };
}

export async function deleteDeliveryNote(id: number) {
  const db = await getDb();
  if (!db) return;
  // Delete child items first (FK), then the note
  await db.delete(deliveryNoteItems).where(eq(deliveryNoteItems.deliveryNoteId, id));
  await db.delete(deliveryNotes).where(eq(deliveryNotes.id, id));
}

export async function bulkDeleteDeliveryNotesByStatus(
  status: "pending" | "ready" | "error"
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // Collect IDs first so we can delete child items
  const toDelete = await db
    .select({ id: deliveryNotes.id })
    .from(deliveryNotes)
    .where(eq(deliveryNotes.status, status));
  if (toDelete.length === 0) return 0;
  const ids = toDelete.map((r) => r.id);
  // Delete items for all matching notes, then the notes themselves
  for (const id of ids) {
    await db.delete(deliveryNoteItems).where(eq(deliveryNoteItems.deliveryNoteId, id));
  }
  await db.delete(deliveryNotes).where(eq(deliveryNotes.status, status));
  return ids.length;
}

export async function updateDeliveryNoteStatus(
  id: number,
  update: {
    status: "pending" | "ready" | "error";
    osapiensSalesOrder?: unknown;
    qrCodeDataUrl?: string | null;
    /** Plain text OSAPV1EDP dispatch QR string */
    dispatchQrText?: string | null;
    errorMessage?: string | null;
    eoid?: string | null;
    /** Customer Facility ID from Xentral freifeld6 */
    fid?: string | null;
    /** Payment method from linked sales order */
    paymentMethod?: string | null;
    /** Delivery/shipping method from linked sales order */
    deliveryMethod?: string | null;
    /** Total tobacco order value (stored as decimal string) */
    orderValue?: string | null;
    /** Currency for order value */
    orderCurrency?: string | null;
    /** Xentral sales order ID */
    salesOrderId?: string | null;
    customerName?: string | null;
    addressStreet?: string | null;
    addressCity?: string | null;
    addressPostalCode?: string | null;
    addressCountry?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  // Build the set object carefully — decimal columns must receive NULL (not undefined)
  // to avoid MySQL ER_TRUNCATED_WRONG_VALUE errors when the value is not provided.
  const setValues: Record<string, unknown> = {
    status: update.status,
  };
  if (update.osapiensSalesOrder !== undefined) setValues.osapiensSalesOrder = update.osapiensSalesOrder;
  if (update.qrCodeDataUrl !== undefined) setValues.qrCodeDataUrl = update.qrCodeDataUrl;
  if (update.dispatchQrText !== undefined) setValues.dispatchQrText = update.dispatchQrText;
  if (update.errorMessage !== undefined) setValues.errorMessage = update.errorMessage;
  if (update.eoid !== undefined) setValues.eoid = update.eoid;
  if (update.fid !== undefined) setValues.fid = update.fid;
  if (update.paymentMethod !== undefined) setValues.paymentMethod = update.paymentMethod;
  if (update.deliveryMethod !== undefined) setValues.deliveryMethod = update.deliveryMethod;
  // Decimal column: only set when we have a valid numeric string value.
  // When null/undefined, skip it entirely to avoid MySQL ER_TRUNCATED_WRONG_VALUE.
  if (update.orderValue !== undefined && update.orderValue !== null) {
    setValues.orderValue = update.orderValue;
  }
  if (update.orderCurrency !== undefined) setValues.orderCurrency = update.orderCurrency;
  if (update.salesOrderId !== undefined) setValues.salesOrderId = update.salesOrderId;
  if (update.customerName !== undefined) setValues.customerName = update.customerName;
  if (update.addressStreet !== undefined) setValues.addressStreet = update.addressStreet;
  if (update.addressCity !== undefined) setValues.addressCity = update.addressCity;
  if (update.addressPostalCode !== undefined) setValues.addressPostalCode = update.addressPostalCode;
  if (update.addressCountry !== undefined) setValues.addressCountry = update.addressCountry;
  await db.update(deliveryNotes).set(setValues as any).where(eq(deliveryNotes.id, id));
}
