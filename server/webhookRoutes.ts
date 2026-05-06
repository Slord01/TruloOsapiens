/**
 * Express route: POST /api/webhook/xentral
 * Accepts Xentral deliveryNote.created webhook payloads.
 * No authentication is required (Xentral pushes to this endpoint).
 * Optionally validate a shared secret via X-Xentral-Signature header.
 */
import type { Express, Request, Response } from "express";
import { processWebhookPayload } from "./webhookProcessor";

export function registerWebhookRoutes(app: Express) {
  app.post("/api/webhook/xentral", async (req: Request, res: Response) => {
    try {
      // Optional shared secret validation
      const secret = process.env.XENTRAL_WEBHOOK_SECRET;
      if (secret) {
        const incoming = req.headers["x-xentral-signature"] ?? req.headers["x-webhook-secret"];
        if (incoming !== secret) {
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
      }

      const payload = req.body;
      if (!payload || typeof payload !== "object") {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }

      const result = await processWebhookPayload(payload);
      res.status(200).json({ success: true, id: result.id, status: result.status });
    } catch (err) {
      console.error("[Webhook] Processing error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json({ error: message });
    }
  });

  // Health check endpoint for Xentral webhook configuration
  app.get("/api/webhook/xentral", (_req: Request, res: Response) => {
    res.json({ status: "ok", endpoint: "TNT Bridge Webhook Receiver" });
  });
}
