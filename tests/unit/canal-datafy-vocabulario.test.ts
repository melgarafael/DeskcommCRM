import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import { CHANNEL_PROVIDER_DATAFY, capabilitiesOf } from "@/lib/channels/capabilities";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";

/**
 * O canal Datafy é parceiro homologado pela Meta que espelha a Cloud API: muda o
 * TRANSPORTE (host/token), não o que o WhatsApp permite. Este teste fixa o
 * vocabulário e as costuras do seam — e o par banco × TypeScript, que o
 * `invariants` cobra no CI.
 */
const DATAFY = "datafy" as const;

describe("canal datafy — vocabulário e seam", () => {
  it("declara o perfil hetero-restrição (como o canal oficial)", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_DATAFY);
    expect(caps.requiresTemplates).toBe(true);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.costPerMessage).toBe(true);
    // Gestão de modelos ainda não exposta nesta primeira versão.
    expect(caps.canManageTemplates).toBe(false);
  });

  it("o sessionRef vem da coluna própria do provider", () => {
    expect(resolveSessionRef({ provider: DATAFY, datafy_phone_number_id: "123456" })).toBe("123456");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("datafy_phone_number_id");
  });

  it("o adapter existe e os códigos de falha carregam o nome", () => {
    const adapter = getAdapter(DATAFY);
    expect(adapter.provider).toBe("datafy");
    expect(adapter.codes.notConfigured).toContain("datafy");
    expect(adapter.codes.sendFailed).toContain("datafy");
    expect(() => getAdapter("telegram" as never)).toThrow(/unknown_channel_provider/);
  });

  it("o baseline e a migration conhecem o provider e o ramo do CHECK", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,300}'datafy'/);
    expect(baseline).toMatch(/provider = 'datafy'\s+and datafy_phone_number_id\s+is not null/);
    expect(baseline).toContain("channel_sessions_datafy_phone_number_id_ativo_unique");

    const mig = readFileSync(
      "supabase/migrations/20260913150000_0235_canal_datafy.sql",
      "utf8",
    );
    expect(mig).toContain("datafy_phone_number_id");
    expect(mig).toContain("'datafy'");
  });
});
