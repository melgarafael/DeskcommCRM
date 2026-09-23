import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ drained: 0 })),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({
  ensureHandlersRegistered: vi.fn(),
}));

import { kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";

describe("kickLocalPipeline", () => {
  it("não propaga erro do tick do contato (contrato: nunca 5xx no webhook)", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => {
              throw new Error("boom do mock");
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      kickLocalPipeline(admin, {
        organizationId: "org",
        contactId: "contact",
      }),
    ).resolves.toBeUndefined();
  });

  it("acorda a espera existente antes de aplicar o texto (não o contrário)", () => {
    const src = readFileSync(join(process.cwd(), "lib/dev/kick-local-pipeline.ts"), "utf8");
    const acordar = src.indexOf("await acordarFollowupPorInbound(admin, inbound)");
    const aplicar = src.indexOf("await aplicarTextoNosFollowups(admin, inbound)");
    expect(acordar).toBeGreaterThan(0);
    expect(aplicar).toBeGreaterThan(acordar);
  });
});
