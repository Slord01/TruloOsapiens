import { describe, expect, it } from "vitest";
import { getDisplayOrderStatus } from "./orderStatus";

describe("getDisplayOrderStatus", () => {
  it("returns Sent for a confirmed Osapiens submission, including a legacy Ready row", () => {
    expect(getDisplayOrderStatus("ready", true)).toBe("sent");
  });

  it("retains Ready, Pending, Error, and Sent when no legacy confirmation overrides it", () => {
    expect(getDisplayOrderStatus("ready", false)).toBe("ready");
    expect(getDisplayOrderStatus("pending", false)).toBe("pending");
    expect(getDisplayOrderStatus("error", false)).toBe("error");
    expect(getDisplayOrderStatus("sent", true)).toBe("sent");
  });
});
