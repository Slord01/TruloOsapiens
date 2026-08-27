export type OrderProcessingStatus = "pending" | "ready" | "sent" | "error";

/**
 * Presents legacy rows that were confirmed by Osapiens before the `sent` enum
 * existed as Sent, while retaining the database status for all other orders.
 */
export function getDisplayOrderStatus(
  status: Exclude<OrderProcessingStatus, "sent"> | OrderProcessingStatus,
  sentToOsapiens: boolean | null | undefined,
): OrderProcessingStatus {
  return sentToOsapiens ? "sent" : status;
}
