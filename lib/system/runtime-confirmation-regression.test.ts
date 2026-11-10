import { describe, expect, it } from "vitest";

import { rollbackDesmentidoPeloApp } from "@/lib/system/update-run";

/** APP_VERSION is only one process: it cannot confirm the deployed release. */
describe("a failed deployment needs host confirmation of the applicable services", () => {
  it("does not clear a failed deployment from APP_VERSION alone", () => {
    expect(rollbackDesmentidoPeloApp({ status: "failed_rolled_back", to_version: "v1.3.0" }, "1.3.0")).toBe(false);
  });

  it("keeps the failure when the app still runs the previous version", () => {
    expect(rollbackDesmentidoPeloApp({ status: "failed_rolled_back", to_version: "v1.3.0" }, "1.2.0")).toBe(false);
  });
});
