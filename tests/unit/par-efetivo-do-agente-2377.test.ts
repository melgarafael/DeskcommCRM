/**
 * O PAR (PROVEDOR, MODELO) QUE NASCE QUANDO NINGUÉM ESCOLHEU — issue #2377.
 *
 * O corpo legado do `POST /api/v1/ai/agents` pode OMITIR `model`. Até este
 * conserto, omitir injetava `anthropic/claude-sonnet-5` escrito à mão na rota:
 * numa instalação cujo provedor efetivo é OpenAI (ou OpenRouter, ou Google), o
 * agente nascia com um id que aquele endereço não executa. O par cruzado nascia
 * na ESCRITA, ficava gravado em `ai_agent_versions` e só aparecia no turno —
 * no caminho especializado, longe da tela que mostra o provedor geral.
 *
 * Duas metades são medidas aqui, e elas têm de concordar:
 *
 *  1. a RESOLUÇÃO (`resolverParEfetivo`), pura e sem banco — os três provedores
 *     da issue × as três instalações (nova, atualização, configuração legada);
 *  2. o CALL SITE (a rota), que é quem grava: a configuração legada
 *     `{provider: 'openai', default_model: 'claude-sonnet-5'}` tem de terminar
 *     em modelo da OpenAI, e sem par sustentável a criação é RECUSADA antes de
 *     qualquer insert — nunca com um Claude silencioso.
 *
 * O log estruturado entra na conta porque a issue pede que ele identifique
 * provedor, modelo, finalidade e origem — e que NÃO exponha chave, prompt,
 * telefone ou conteúdo de conversa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { resolverParEfetivo } from "@/lib/ai/par-provedor-modelo";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

// ═══════════════════════════════════════════════════════════════════════════
// PARTE 1 — a RESOLUÇÃO: três provedores × três instalações
// ═══════════════════════════════════════════════════════════════════════════

/** Nunca chame este leitor num teste que não seja o do degrau do catálogo. */
const leitorProibido = async (): Promise<string | null> => {
  throw new Error("o catálogo não deveria ter sido lido neste caso");
};

describe("resolverParEfetivo — OpenAI", () => {
  it("instalação nova: o par sai do padrão da organização, inteiro", async () => {
    const r = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "openai", default_model: "gpt-5.6-luna" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "openai",
      model: "gpt-5.6-luna",
      origem: "padrao_da_organizacao",
    });
  });

  it("atualização: o prefixo do próprio provedor no gravado não vira modelo", async () => {
    const r = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "openai", default_model: "openai/gpt-5.4" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r).toMatchObject({ ok: true, provider: "openai", model: "gpt-5.4" });
  });

  it("configuração legada (openai + claude-sonnet-5) vai ao catálogo, nunca ao Claude", async () => {
    const lidos: string[] = [];
    const r = await resolverParEfetivo({
      // É LITERALMENTE o par da issue: o gatilho semeou o par da Anthropic e o
      // instalador antigo trocou só o provedor.
      llmDaOrganizacao: { provider: "openai", default_model: "claude-sonnet-5" },
      lerModeloDoCatalogo: async (provider) => {
        lidos.push(provider);
        return "gpt-5.6-terra";
      },
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "openai",
      model: "gpt-5.6-terra",
      origem: "catalogo_do_provedor",
    });
    // O catálogo é consultado do provedor EFETIVO, não do dono do id gravado.
    expect(lidos).toEqual(["openai"]);
  });

  it("configuração legada sem catálogo legível RECUSA, em vez de gravar Claude", async () => {
    const r = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "openai", default_model: "claude-sonnet-5" },
      lerModeloDoCatalogo: async () => null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.provider).toBe("openai");
    expect(r.motivo).toContain("openai");
    expect(r.motivo).toContain("claude-sonnet-5");
    expect(r.motivo).not.toContain('"anthropic"');
  });

  it("id BARE de outra família é recusado: o par tem de fechar com o endereço", async () => {
    const r = await resolverParEfetivo({
      modeloInformado: "claude-sonnet-5",
      llmDaOrganizacao: { provider: "openai", default_model: "gpt-5.6-luna" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A mensagem carrega os dois lados — é ela que a API devolve com 422.
    expect(r.motivo).toContain("anthropic");
    expect(r.motivo).toContain("openai");
  });

  it("nenhum degrau devolve Claude numa instalação OpenAI", async () => {
    const entradas = [
      { llmDaOrganizacao: { provider: "openai", default_model: "claude-sonnet-5" } },
      { llmDaOrganizacao: { provider: "openai", default_model: "gpt-5.6-luna" } },
      { llmDaOrganizacao: { provider: "openai", default_model: null } },
      { llmDaOrganizacao: { provider: "openai" } },
      { llmDaOrganizacao: null },
    ];
    for (const entrada of entradas) {
      // Sem organização legível o produto cai no provedor de compatibilidade
      // (Anthropic) — o que NÃO pode acontecer é uma instalação OpenAI resolvida
      // como OpenAI receber um id da Anthropic.
      if (entrada.llmDaOrganizacao === null) continue;
      const r = await resolverParEfetivo({
        ...entrada,
        lerModeloDoCatalogo: async () => "gpt-5.6-terra",
      });
      expect(r.ok, JSON.stringify(entrada)).toBe(true);
      if (!r.ok) continue;
      expect(r.provider).toBe("openai");
      expect(r.model).not.toContain("claude");
    }
  });
});

describe("resolverParEfetivo — Anthropic", () => {
  it("instalação nova: o padrão da organização vence", async () => {
    const r = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "anthropic", default_model: "claude-haiku-4-5" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      origem: "padrao_da_organizacao",
    });
  });

  it("o legado Anthropic continua valendo — como compatibilidade EXPLÍCITA do provedor", async () => {
    const semPadrao = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "anthropic" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(semPadrao).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      origem: "compatibilidade_do_provedor",
    });
  });
});

describe("resolverParEfetivo — OpenRouter", () => {
  it("o `/` do id do agregador não troca o provedor da empresa", async () => {
    const r = await resolverParEfetivo({
      // O id da OpenRouter carrega o fabricante do modelo — recortá-lo aqui
      // trocaria o provedor da empresa pelo dono do id, que é o cruzamento que
      // esta frente existe para impedir.
      llmDaOrganizacao: { provider: "openrouter", default_model: "anthropic/claude-sonnet-5" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
      origem: "padrao_da_organizacao",
    });
  });

  it("sem padrão, o catálogo sincronizado do agregador resolve o par", async () => {
    const r = await resolverParEfetivo({
      llmDaOrganizacao: { provider: "openrouter" },
      lerModeloDoCatalogo: async (provider) =>
        provider === "openrouter" ? "openai/gpt-5-mini" : null,
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      origem: "catalogo_do_provedor",
    });
  });

  it("o modelo INFORMADO no corpo é escolha, e vale a rota do id", async () => {
    const r = await resolverParEfetivo({
      modeloInformado: "anthropic/claude-sonnet-4-6",
      llmDaOrganizacao: { provider: "openrouter", default_model: "openai/gpt-5-mini" },
      lerModeloDoCatalogo: leitorProibido,
    });
    expect(r).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      origem: "informado",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE 2 — o CALL SITE: o que a rota grava (e o que ela recusa gravar)
// ═══════════════════════════════════════════════════════════════════════════

/** Inserts capturados por tabela, na ordem em que a rota os fez. */
let gravados: Record<string, Record<string, unknown>[]>;
/** `organizations.settings.llm` da instalação sob teste. */
let llmDaOrganizacao: unknown;
/** Linhas de `ai_models` do provedor — o catálogo da instalação. */
let catalogo: Record<string, unknown>[];

function adminFake() {
  gravados = {};
  const cliente = {
    from(tabela: string) {
      const fila = (gravados[tabela] ??= []);
      const cadeia: Record<string, unknown> = {};
      const devolve = () => cadeia;
      cadeia.insert = (payload: Record<string, unknown>) => {
        fila.push(payload);
        return devolve();
      };
      cadeia.update = (payload: Record<string, unknown>) => {
        fila.push({ __rollback: payload });
        return devolve();
      };
      cadeia.select = () => devolve();
      cadeia.eq = () => devolve();
      cadeia.is = () => devolve();
      cadeia.in = () => devolve();
      cadeia.order = () => devolve();
      cadeia.limit = () => devolve();
      cadeia.maybeSingle = async () =>
        tabela === "organizations"
          ? { data: { settings: { llm: llmDaOrganizacao } }, error: null }
          : { data: null, error: null };
      cadeia.single = async () => {
        const payload = fila[fila.length - 1] ?? {};
        return { data: { id: `${tabela}-id`, organization_id: ORG, ...payload }, error: null };
      };
      // `escolherModeloNoCatalogo` faz `await` no FIM da cadeia (`.is(...)`), e é
      // assim que as linhas do catálogo chegam — sem isto o leitor veria zero
      // modelos e todo caso cairia no ramo de recusa.
      cadeia.then = (resolver: (valor: unknown) => unknown) =>
        Promise.resolve(
          tabela === "ai_models" ? { data: catalogo, error: null } : { data: null, error: null },
        ).then(resolver);
      return cadeia;
    },
  };
  return cliente;
}

function post(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/ai/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

function gravado(tabela: string): Record<string, unknown> {
  const fila = gravados[tabela];
  const linha = fila?.[fila.length - 1];
  if (linha === undefined) throw new Error(`a rota não gravou nada em ${tabela}`);
  return linha;
}

beforeEach(() => {
  vi.clearAllMocks();
  llmDaOrganizacao = null;
  catalogo = [];
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(tetoDeEscritaDoToken).mockResolvedValue(null);
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    organizationId: ORG,
    idioma: "pt-BR",
    actor: { type: "user", id: USER },
    apiTokenId: null,
  } as unknown as Awaited<ReturnType<typeof resolveAuthDual>>);
  vi.mocked(createAdminClient).mockReturnValue(adminFake() as never);
});

describe("POST /api/v1/ai/agents — o par efetivo gravado (issue #2377)", () => {
  it("instalação legada (openai + claude-sonnet-5) grava OpenAI, nunca Claude", async () => {
    llmDaOrganizacao = { provider: "openai", default_model: "claude-sonnet-5" };
    catalogo = [{ model_id: "gpt-5.6-luna", supports_tools: true, is_default_for_provider: true }];

    const res = await (
      await import("@/app/api/v1/ai/agents/route")
    ).POST(post({ name: "Tobias", system_prompt: "Você é o Tobias, atendente da loja." }));

    expect(res.status, await res.clone().text()).toBe(201);
    expect(gravado("ai_agents").model).toBe("openai/gpt-5.6-luna");
    const versao = gravado("ai_agent_versions");
    expect(versao.provider).toBe("openai");
    expect(versao.model).toBe("gpt-5.6-luna");
    // A régua inteira: nenhuma linha gravada cita a Anthropic.
    expect(JSON.stringify(gravados)).not.toContain("claude");
    expect(JSON.stringify(gravados)).not.toContain("anthropic");
    // Segue sendo criação de mcp_agent pelo corpo legado.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_agent.created",
        metadata: expect.objectContaining({ kind: "mcp_agent", formato: "legado" }),
      }),
    );
  });

  it("sem par sustentável a criação é RECUSADA antes de qualquer insert", async () => {
    // O par legado é incoerente e o catálogo da OpenAI não foi lido nesta
    // instalação: o desfecho honesto é recusar com erro claro, não gravar um id
    // que o endereço configurado não executa.
    llmDaOrganizacao = { provider: "openai", default_model: "claude-sonnet-5" };
    catalogo = [];

    const res = await (
      await import("@/app/api/v1/ai/agents/route")
    ).POST(post({ name: "Tobias", system_prompt: "Você é o Tobias, atendente da loja." }));

    expect(res.status, await res.clone().text()).toBe(422);
    const corpo = (await res.json()) as { error?: { message?: string } };
    expect(corpo.error?.message).toContain("openai");
    expect(gravados.ai_agents).toBeUndefined();
    expect(gravados.ai_agent_versions).toBeUndefined();
  });

  it("o log da criação diz provedor, modelo, finalidade e origem — e só isso", async () => {
    llmDaOrganizacao = { provider: "openai", default_model: "gpt-5.6-luna" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const res = await (
        await import("@/app/api/v1/ai/agents/route")
      ).POST(
        post({
          name: "Tobias",
          system_prompt: "Você é o Tobias, atendente da loja. Pré-prompt secreto do cliente.",
          model: "anthropic/claude-haiku-4-5",
        }),
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const linhas = log.mock.calls
        .map(([primeira]) => String(primeira))
        .filter((linha) => linha.includes("par provedor+modelo"));
      expect(linhas).toHaveLength(1);
      const registro = JSON.parse(linhas[0]!) as Record<string, unknown>;
      expect(registro).toMatchObject({
        purpose: "agent_turn",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        origem_da_configuracao: "informado",
        organization_id: ORG,
      });
      // Nem chave, nem prompt, nem telefone, nem conteúdo de conversa.
      expect(linhas[0]).not.toContain("secreto");
      expect(linhas[0]).not.toContain("sk-");
    } finally {
      log.mockRestore();
    }
  });
});
