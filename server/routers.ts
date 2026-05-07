import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { listDeliveryNotes, getDeliveryNoteById, deleteDeliveryNote, bulkDeleteDeliveryNotesByStatus } from "./db";
import { refreshProductCache, getCacheStats } from "./productCache";
import { retryDeliveryNote } from "./webhookProcessor";
import { fetchAndProcessDeliveryNotes } from "./xentralPoller";

// ─── Admin guard ──────────────────────────────────────────────────────────────
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// ─── App Router ───────────────────────────────────────────────────────────────
export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Orders ────────────────────────────────────────────────────────────────
  orders: router({
    list: protectedProcedure
      .input(
        z.object({
          page: z.number().min(1).default(1),
          pageSize: z.number().min(1).max(100).default(20),
          status: z.enum(["pending", "ready", "error"]).optional(),
          search: z.string().optional(),
        })
      )
      .query(async ({ input }) => {
        const result = await listDeliveryNotes(input);
        return {
          notes: result.notes.map((n) => ({
            id: n.id,
            xentralId: n.xentralId,
            xentralNumber: n.xentralNumber,
            customerName: n.customerName,
            eoid: n.eoid,
            status: n.status,
            errorMessage: n.errorMessage,
            deliveryDate: n.deliveryDate,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          })),
          total: result.total,
          page: input.page,
          pageSize: input.pageSize,
        };
      }),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const note = await getDeliveryNoteById(input.id);
        if (!note) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
        // Warehouse users only see QR + basic info; admins see full detail
        if (ctx.user.role === "user") {
          return {
            id: note.id,
            xentralNumber: note.xentralNumber,
            customerName: note.customerName,
            status: note.status,
            errorMessage: note.errorMessage,
            qrCodeDataUrl: note.qrCodeDataUrl,
            eoid: note.eoid,
            addressStreet: note.addressStreet,
            addressCity: note.addressCity,
            addressPostalCode: note.addressPostalCode,
            addressCountry: note.addressCountry,
            deliveryDate: note.deliveryDate,
            items: note.items,
            osapiensSalesOrder: null, // hidden from warehouse
            rawPayload: null,
          };
        }
        return {
          ...note,
          rawPayload: note.rawPayload,
        };
      }),

    retry: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const result = await retryDeliveryNote(input.id);
        return result;
      }),

    /**
     * Fetch Orders — admin-only procedure that actively polls the Xentral API
     * for recent delivery notes and processes them through the pipeline.
     * This is the primary way to get orders into the dashboard without webhooks.
     */
    fetchFromXentral: adminProcedure
      .input(
        z.object({
          lookbackDays: z.number().min(1).max(90).default(7),
        })
      )
      .mutation(async ({ input }) => {
        const result = await fetchAndProcessDeliveryNotes(input.lookbackDays);
        return result;
      }),

    /** Delete a single delivery note by DB id (admin only). */
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteDeliveryNote(input.id);
        return { success: true };
      }),

    /** Bulk-delete all delivery notes with a given status (admin only). */
    bulkDelete: adminProcedure
      .input(z.object({ status: z.enum(["pending", "ready", "error"]) }))
      .mutation(async ({ input }) => {
        const count = await bulkDeleteDeliveryNotesByStatus(input.status);
        return { deleted: count };
      }),
  }),

  // ─── Products (Admin only) ─────────────────────────────────────────────────
  products: router({
    sync: adminProcedure.mutation(async () => {
      const result = await refreshProductCache();
      if (result.error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Sync failed: ${result.error}`,
        });
      }
      return { count: result.count, syncedAt: new Date() };
    }),
    cacheStats: protectedProcedure.query(() => {
      return getCacheStats();
    }),
  }),
});

export type AppRouter = typeof appRouter;
