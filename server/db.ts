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
        addressStreet: note.addressStreet,
        addressCity: note.addressCity,
        addressPostalCode: note.addressPostalCode,
        addressCountry: note.addressCountry,
        rawPayload: note.rawPayload,
        osapiensSalesOrder: note.osapiensSalesOrder,
        qrCodeDataUrl: note.qrCodeDataUrl,
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

export async function updateDeliveryNoteStatus(
  id: number,
  update: {
    status: "pending" | "ready" | "error";
    osapiensSalesOrder?: unknown;
    qrCodeDataUrl?: string | null;
    errorMessage?: string | null;
    eoid?: string | null;
    customerName?: string | null;
    addressStreet?: string | null;
    addressCity?: string | null;
    addressPostalCode?: string | null;
    addressCountry?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(deliveryNotes).set(update).where(eq(deliveryNotes.id, id));
}
