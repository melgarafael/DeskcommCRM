import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import { CHANNEL_PROVIDER_OLX, capabilitiesOf, transportaMensagem } from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

/**
 * O canal OLX (issue #2927) — vocabulário e costuras do seam, fatia 1.
 *
 * O chat da OLX endereça por THREAD de vendedor, como o canal por BSP — muda o
 * que o provedor oferece (só TEXTO, sem definição aprovada e sem janela), então
 * o perfil de restrição é auto-restrito. Este arquivo fixa o perfil, o
 * `sessionRef`, o adapter e o par migration × baseline — os artefatos que andam
 * juntos.
 *
 * O que NÃO está aqui, por exigir credencial que esta instalação não tem: o
 * OAuth contra `auth.olx.com.br`, o registro do webhook e o envio com 200. Ver
 * `channel-adapter-olx.test.ts` (contrato pendente) e a nota no adapter.
 */
const OLX = "olx" as const;
const MIGRATION = "supabase/migrations/20261022140000_0727_canal_olx.sql";

describe("canal olx — vocabulário e seam", () => {
  it("declara o perfil auto-restrito do chat: só texto, sem definição e sem janela", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_OLX);
    // Sem definição aprovada e sem gestão de modelo — a capability e a fonte
    // de templates têm de concordar (as duas `false`/`null`).
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(fonteDeTemplates(OLX)).toBeNull();
    // A OLX não publica janela de 24h para o chat: não há relógio a respeitar.
    expect(caps.freeformOutsideWindow).toBe(true);
    // Auto-restrição, não hetero — as duas famílias nunca coexistem.
    expect(caps.banRisk).toBe(false);
    expect(caps.minIntervalMs).toBeNull();
    expect(caps.groups).toBe("none");
    expect(caps.costPerMessage).toBe(false);
    expect(caps.phonebook).toBe(false);
  });

  it("é canal de MENSAGEM e não se apresenta como WhatsApp nem como o fornecedor", () => {
    expect(transportaMensagem(OLX)).toBe(true);
    // A OLX não é a rede do WhatsApp: a marca própria é trabalho de UI de uma
    // fatia seguinte; hoje o default honesto é "unknown" (sem inventar logo).
    expect(channelBrand({ provider: OLX })).toBe("unknown");
  });

  it("o sessionRef vem da conta de vendedor, e ela entra no select", () => {
    expect(resolveSessionRef({ provider: OLX, olx_seller_id: "seller-42" })).toBe("seller-42");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("olx_seller_id");
  });

  it("o adapter existe, falha fechado para o vizinho e os códigos carregam o nome", () => {
    const adapter = getAdapter(OLX);
    expect(adapter.provider).toBe(OLX);
    expect(adapter.codes.notConfigured).toBe("olx_not_configured");
    expect(adapter.codes.sendFailed).toContain(OLX);
    // Fail-closed: provider fora da matriz lança em vez de cair no WAHA.
    expect(() => getAdapter("telegram" as never)).toThrow(/unknown_channel_provider/);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,700}'olx'::text/);
    expect(baseline).toMatch(/provider = 'olx'\s+and olx_seller_id\s+is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]*?'olx'/);
    expect(baseline).toContain("channel_sessions_olx_seller_id_ativo_unique");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists olx_seller_id")).toBeLessThan(
      baseline.indexOf("(provider = 'olx'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig).toContain("add column if not exists olx_seller_id");
    expect(mig).toMatch(/provider = 'olx' and olx_seller_id is not null/);
    expect(mig).toContain("'olx'");
    // A descrição vive no cabeçalho `-- manifest:` do próprio .sql.
    expect(mig).toMatch(/^-- manifest:/m);
  });
});
