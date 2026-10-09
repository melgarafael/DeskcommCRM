/**
 * A PUBLICAÇÃO EMITE `ai_agent.legal_handoff_changed` SÓ QUANDO A CHAVE MUDOU.
 *
 * Seção 5 do desenho do mantenedor (comentário 5999897516 no PR #2156). O
 * registro novo NÃO substitui `ai_agent.published` (que os call sites continuam
 * emitindo): ele fica à parte e responde "quando esta empresa desligou a chave
 * por assunto jurídico?" — por isso só emite quando o VALOR da publicação
 * difere do valor publicado antes.
 *
 * Os cinco casos:
 *
 * 1. primeira publicação (sem versão anterior) já com a chave DESLIGADA →
 *    audita, com `previous_version_id: null` (a referência é o PADRÃO da
 *    coluna, ligado);
 * 2. primeira publicação com a chave LIGADA → silêncio (não mudou nada);
 * 3. anterior ligada → nova desligada → audita com a versão anterior;
 * 4. anterior desligada → nova desligada → silêncio (publicar rascunho que não
 *    mexeu na chave não é mudança de chave);
 * 5. anterior desligada → nova ligada → audita, `enabled: true` (voltou ao
 *    padrão, e isso também é uma mudança).
 *
 * O ponto é ÚNICO (`publishAgentVersion`), então os três caminhos que
 * publicam — rota REST, salvar rascunho e reverter — passam por ele.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: () => true }));

import { audit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { audarMudancaDeChaveJuridica, publishAgentVersion } from "@/lib/ai/agents/publish";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";

interface Cenario {
  /** Valor da chave na versão que está sendo publicada. */
  alvo: boolean;
  /** Valor na versão publicada antes, ou `null` se não havia nenhuma. */
  anterior: boolean | null;
  /** `false` = chamar o wrapper publicar; `true` = chamar só o registrador. */
  soRegistrador?: boolean;
}

function adminDuble({ alvo, anterior, soRegistrador = false }: Cenario) {
  let leituras = 0;
  return {
    from: (tabela: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          expect(tabela).toBe("ai_agent_versions");
          leituras += 1;
          // 1ª leitura = a versão que vai ser publicada; as seguintes = a anterior.
          const dados = soRegistrador || leituras > 1
            ? anterior === null
              ? null
              : { handoff_legal_enabled: anterior }
            : { provider: "anthropic", credential_id: "cred-1", handoff_legal_enabled: alvo };
          return { data: dados, error: null };
        },
      };
      return chain;
    },
    rpc: async () => ({
      data: {
        agent_id: AGENTE,
        version_id: "v2",
        previous_version_id: anterior === null ? null : "v1",
        published_at: "2026-10-08T00:00:00Z",
      },
      error: null,
    }),
  };
}

async function publicar(c: Cenario) {
  const admin = adminDuble(c);
  if (c.soRegistrador) {
    await audarMudancaDeChaveJuridica(admin as never, {
      orgId: ORG,
      agentId: AGENTE,
      versionId: "v2",
      previousVersionId: c.anterior === null ? null : "v1",
      enabled: c.alvo,
      // Sem `quemPublicou`: é como ficam os caminhos automatizados.
    });
    return { ok: true } as const;
  }
  return publishAgentVersion(admin as never, {
    orgId: ORG,
    agentId: AGENTE,
    versionId: "v2",
    quemPublicou: { actorUserId: "user-1", requestId: "req-1" },
  });
}

function linhas() {
  return vi.mocked(audit).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
}

function daChave() {
  return linhas().filter((l) => l.action === "ai_agent.legal_handoff_changed");
}

beforeEach(() => vi.clearAllMocks());

describe("ai_agent.legal_handoff_changed", () => {
  it("está no vocabulário de auditoria (sem isso a ação nem compila)", () => {
    expect(AUDIT_ACTIONS).toContain("ai_agent.legal_handoff_changed");
  });

  it("caso 1 — primeira publicação já desligada audita com previous_version_id: null", async () => {
    const r = await publicar({ alvo: false, anterior: null });
    expect(r.ok).toBe(true);
    const linhasDaChave = daChave();
    expect(linhasDaChave).toHaveLength(1);
    expect(linhasDaChave[0]).toMatchObject({
      action: "ai_agent.legal_handoff_changed",
      organizationId: ORG,
      resourceType: "ai_agent",
      resourceId: AGENTE,
      actorUserId: "user-1",
      requestId: "req-1",
      metadata: { version_id: "v2", previous_version_id: null, enabled: false },
    });
  });

  it("caso 2 — primeira publicação LIGADA não audita (não mudou nada)", async () => {
    const r = await publicar({ alvo: true, anterior: null });
    expect(r.ok).toBe(true);
    expect(daChave()).toEqual([]);
    // O call site continua emitindo o registro de publicação normal — este
    // arquivo não o emite, ele mora nos call sites.
    expect(linhas()).toEqual([]);
  });

  it("caso 3 — ligada → desligada audita apontando a versão anterior", async () => {
    await publicar({ alvo: false, anterior: true });
    expect(daChave()).toHaveLength(1);
    expect(daChave()[0]?.metadata).toMatchObject({
      version_id: "v2",
      previous_version_id: "v1",
      enabled: false,
    });
  });

  it("caso 4 — desligada → desligada: silêncio", async () => {
    await publicar({ alvo: false, anterior: false });
    expect(daChave()).toEqual([]);
  });

  it("caso 5 — desligada → ligada audita com enabled: true", async () => {
    await publicar({ alvo: true, anterior: false });
    expect(daChave()).toHaveLength(1);
    expect(daChave()[0]?.metadata).toMatchObject({
      previous_version_id: "v1",
      enabled: true,
    });
  });

  it("sem caminho publicado antes, a referência é o PADRÃO da coluna (ligado)", async () => {
    // O registrador é chamado direto, como ficaria para um call site sem ator
    // (onboarding/proposta): o registro sai mesmo assim, com ator nulo.
    await publicar({ alvo: false, anterior: null, soRegistrador: true });
    expect(daChave()).toHaveLength(1);
    expect(daChave()[0]).toMatchObject({
      actorUserId: null,
      metadata: { previous_version_id: null, enabled: false },
    });
  });
});
