import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import { CHANNEL_PROVIDER_DATAFY, capabilitiesOf, transportaMensagem } from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

/**
 * O canal Datafy (recorte do #1130, @vgamkt) — vocabulário e costuras do seam.
 *
 * O parceiro espelha a Cloud API: muda o TRANSPORTE (host/token), não o que o
 * WhatsApp permite. Este arquivo fixa o perfil, o `sessionRef`, o adapter e o
 * par migration × baseline — os três artefatos que andam juntos.
 */
const DATAFY = "datafy" as const;
const MIGRATION = "supabase/migrations/20260922164700_0387_canal_datafy.sql";

describe("canal datafy — vocabulário e seam", () => {
  it("declara o perfil hetero-restrição, como o canal oficial", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_DATAFY);
    expect(caps.requiresTemplates).toBe(true);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.costPerMessage).toBe(true);
    expect(caps.voiceNote).toBe("opus-only");
    // Modelos são os da Cloud API; o parceiro expõe o catálogo. A fonte de
    // modelos tem de concordar com a capability.
    expect(caps.canManageTemplates).toBe(true);
    expect(fonteDeTemplates(DATAFY)).toBe("graph");
  });

  it("é canal de MENSAGEM e aparece como WhatsApp, nunca como a marca do fornecedor", () => {
    expect(transportaMensagem(DATAFY)).toBe(true);
    expect(channelBrand({ provider: DATAFY })).toBe("whatsapp");
  });

  it("o sessionRef vem da coluna própria do provider, e ela entra no select", () => {
    expect(resolveSessionRef({ provider: DATAFY, datafy_phone_number_id: "123456" })).toBe("123456");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("datafy_phone_number_id");
  });

  it("o adapter existe e os códigos de falha carregam o nome", () => {
    const adapter = getAdapter(DATAFY);
    expect(adapter.provider).toBe(DATAFY);
    expect(adapter.codes.notConfigured).toBe("datafy_not_configured");
    expect(adapter.codes.sendFailed).toContain(DATAFY);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,600}'datafy'::text/);
    expect(baseline).toMatch(/provider = 'datafy'\s+and datafy_phone_number_id\s+is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([^)]*'datafy'/);
    expect(baseline).toContain("channel_sessions_datafy_phone_number_id_ativo_unique");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists datafy_phone_number_id")).toBeLessThan(
      baseline.indexOf("(provider = 'datafy'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig).toContain("add column if not exists datafy_phone_number_id");
    expect(mig).toMatch(/provider = 'datafy' and datafy_phone_number_id is not null/);
    expect(mig).toContain("'datafy'");

    const manifest = readFileSync("supabase/migrations/MANIFEST.md", "utf8");
    expect(manifest).toContain("`0387_canal_datafy`");
  });
});
