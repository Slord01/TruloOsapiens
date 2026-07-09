import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { listDeliveryNotes, getDeliveryNoteById, deleteDeliveryNote, bulkDeleteDeliveryNotesByStatus, markSentToOsapiens, markOsapiensSendError, getOsapiensLogs } from "./db";
import { getLogEntries } from "./logBuffer";
import { sendDispatchToOsapiens, isOsapiensConfigured } from "./osapiensSender";
import { refreshProductCache, getCacheStats } from "./productCache";
import { retryDeliveryNote } from "./webhookProcessor";
import { fetchAndProcessDeliveryNotes, fetchDeliveryNoteByDocumentNumber } from "./xentralPoller";

// ─── Admin guard (disabled — app is public, no auth required) ────────────────
const adminProcedure = publicProcedure;

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
    list: publicProcedure
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
            fid: n.fid,
            status: n.status,
            errorMessage: n.errorMessage,
            deliveryDate: n.deliveryDate,
            sentToOsapiens: n.sentToOsapiens,
            sentToOsapiensAt: n.sentToOsapiensAt,
            osapiensSendError: n.osapiensSendError,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          })),
          total: result.total,
          page: input.page,
          pageSize: input.pageSize,
        };
      }),

    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const note = await getDeliveryNoteById(input.id);
        if (!note) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
        return {
          ...note,
          rawPayload: note.rawPayload,
        };
      }),

    retry: publicProcedure
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

    /**
     * Fetch a single delivery note by its Xentral document number (e.g. LN-2026-00123).
     * Bypasses the date filter — useful for fetching a specific order immediately.
     */
    fetchByDocumentNumber: adminProcedure
      .input(z.object({ documentNumber: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const result = await fetchDeliveryNoteByDocumentNumber(input.documentNumber);
        return result;
      }),

    /**
     * Send a dispatch event for a delivery note to the Osapiens API.
     * Available to all authenticated users (not admin-only).
     */
    sendToOsapiens: publicProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const result = await sendDispatchToOsapiens(input.id);
        if (result.success) {
          await markSentToOsapiens(input.id);
          return { success: true, message: "Dispatch event sent to Osapiens successfully" };
        } else {
          await markOsapiensSendError(input.id, result.error ?? "Unknown error");
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: result.error ?? "Failed to send to Osapiens",
          });
        }
      }),

    /** Check if Osapiens credentials are configured */
    osapiensStatus: publicProcedure.query(() => {
      return { configured: isOsapiensConfigured() };
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

  // ─── Logs ───────────────────────────────────────────────────────────────────
  logs: router({
    list: publicProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(500).default(200),
          offset: z.number().min(0).default(0),
          filter: z.enum(["all", "success", "failure"]).default("all"),
        })
      )
      .query(async ({ input }) => {
        const result = await getOsapiensLogs({
          limit: input.limit,
          offset: input.offset,
          successOnly: input.filter === "success",
          failureOnly: input.filter === "failure",
        });
        return result;
      }),

    /** Live server console output — in-memory circular buffer (last 500 lines) */
    getLive: publicProcedure
      .input(
        z.object({
          since: z.number().optional(),   // return only entries newer than this id
          level: z.enum(["all", "log", "warn", "error", "info"]).default("all"),
          limit: z.number().min(1).max(500).default(200),
        })
      )
      .query(({ input }) => {
        return getLogEntries({
          since: input.since,
          level: input.level === "all" ? undefined : input.level,
          limit: input.limit,
        });
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
    cacheStats: publicProcedure.query(() => {
      return getCacheStats();
    }),
  }),
});

export type AppRouter = typeof appRouter;
