/**
 * GET /api/v1/ai/providers — o follow-up aparece no painel, EDITÁVEL, e diz a
 * verdade sobre o modelo que usa.
 *
 * O ponto `followup_turn` é o agente escrevendo sozinho para quem parou de
 * responder. A tela tem de mostrar três coisas que o motor faz:
 *
 *  - ele está em "Atender o cliente" e aceita escolha (não é leitura, como a
 *    resposta ao cliente, que mora na versão publicada);
 *  - sem escolha, o modelo anunciado é o da VERSÃO PUBLICADA — não o padrão da
 *    organização. Sem o agente chegar ao resolvedor da tela, ela anunciaria o
 *    padrão num ponto que em runtime usa o agente: a tela que mente;
 *  - com escolha, o modelo do painel, com "Escolhido por você".
 *
 * E o controle: a mesma escolha gravada em `agent_turn` não muda o que a tela
 * anuncia para a resposta ao cliente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";

const banco = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  versao: null as null | { provider: string; model: string; credential_id: string | null },
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const lista = tabela === "ai_purpose_bindings" ? banco.bindings : [];
      const uma =
        tabela === "organizations"
          ? { settings: { llm: { provider: "anthropic", default_model: "claude-padrao-da-org" } } }
          : tabela === "ai_agents" && banco.versao !== null
            ? { id: "agente-1", name: "Vendedor", published_version_id: "v1", versao: banco.versao }
            : null;
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: uma, error: null }),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve({ data: lista, error: null }).then(ok, erro),
      };
      for (const m of ["select", "eq", "is", "not", "order", "limit"]) chain[m] = () => chain;
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/ai/providers/route";

interface PontoDaTela {
  id: string;
  papel: string;
  exige: { tools?: boolean };
  mandadoPeloAgente: boolean;
  efetivo: { provider: string; modelId: string | null; origem: string; porQue: string };
}

async function pontos(): Promise<Map<string, PontoDaTela>> {
  const res = await GET();
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: { pontos: PontoDaTela[] } };
  return new Map(corpo.data.pontos.map((p) => [p.id, p]));
}

const ESCOLHA = {
  purpose: "followup_turn",
  provider: "openai",
  credential_id: null,
  model_id: "gpt-5.6-luna",
  base_url: null,
  is_enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  banco.bindings = [];
  banco.versao = { provider: "anthropic", model: "claude-sonnet-5", credential_id: "cred-anthropic" };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "actor", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
});

describe("o follow-up no painel de provedores", () => {
  it("está em 'Atender o cliente', exige ferramentas e é editável — não é leitura como a resposta", async () => {
    const p = await pontos();
    const seguimento = p.get("followup_turn");
    expect(seguimento, "o ponto não chegou à tela").toBeDefined();
    expect(seguimento!.papel).toBe("atender");
    expect(seguimento!.exige.tools).toBe(true);
    expect(seguimento!.mandadoPeloAgente).toBe(false);
    // Controle: a resposta ao cliente continua travada na versão publicada.
    expect(p.get("agent_turn")!.mandadoPeloAgente).toBe(true);
  });

  it("sem escolha: anuncia o modelo da versão publicada, não o padrão da organização", async () => {
    const seguimento = (await pontos()).get("followup_turn")!;
    expect(seguimento.efetivo).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      origem: "agente_publicado",
      porQue: "Definido na versão publicada do agente.",
    });
  });

  it("com escolha: anuncia o modelo do painel", async () => {
    banco.bindings = [ESCOLHA];
    const seguimento = (await pontos()).get("followup_turn")!;
    expect(seguimento.efetivo).toMatchObject({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      origem: "binding",
      porQue: "Escolhido por você no painel de provedores.",
    });
  });

  it("controle: a escolha do follow-up não muda o que a tela anuncia para a resposta ao cliente", async () => {
    banco.bindings = [ESCOLHA, { ...ESCOLHA, purpose: "agent_turn" }];
    const resposta = (await pontos()).get("agent_turn")!;
    expect(resposta.efetivo).toMatchObject({ modelId: "claude-sonnet-5", origem: "agente_publicado" });
  });

  it("sem agente publicado: o follow-up cai no padrão da organização, como a resposta", async () => {
    banco.versao = null;
    const p = await pontos();
    expect(p.get("followup_turn")!.efetivo).toMatchObject({
      modelId: "claude-padrao-da-org",
      origem: "padrao_da_organizacao",
    });
    expect(p.get("followup_turn")!.efetivo.modelId).toBe(p.get("agent_turn")!.efetivo.modelId);
  });
});
