import { describe, expect, it } from "vitest";

const baseUrl = (process.env.XENTRAL_API_URL ?? process.env.XENTRAL_BASE_URL)?.replace(/\/$/, "");
const apiKey = process.env.XENTRAL_API_KEY;
const runLiveCredentialCheck = process.env.RUN_XENTRAL_CREDENTIAL_TEST === "1";

/**
 * Read-only credential smoke test. It is intentionally opt-in because Xentral
 * rate-limits API requests and the regular suite must not consume live quota.
 * Run with RUN_XENTRAL_CREDENTIAL_TEST=1 in a WebDev environment with both
 * Xentral secrets supplied.
 */
describe.runIf(Boolean(baseUrl && apiKey && runLiveCredentialCheck))("Xentral credential", () => {
  it("can list one delivery note with the configured personal access token", async () => {
    const response = await fetch(`${baseUrl}/api/v3/deliveryNotes?perPage=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.text();
    expect(
      response.ok,
      `Xentral rejected the configured token: ${response.status} ${response.statusText}; ${body.slice(0, 300)}`
    ).toBe(true);
  }, 20_000);
});
