import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const erroDeLog = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...args: unknown[]) => erroDeLog(...args) } }));

import {
  avisoDeVazioDeCasos,
  lerLiberacaoDeCasos,
  LIBERACAO_INDEFINIDA,
} from "@/lib/ai/cases/liberacao-de-casos";

/**
 * O cliente falso encadeia `select/eq/is` e resolve no `await` — o mesmo
 * formato que a função usa (`await client.from(...).select(...)...`). O `is`
 * FILTRA de verdade: é ele que deixa o agente arquivado de fora, e um dublê que
 * ignora o filtro provaria o contrário do que o teste diz.
 */
function clienteFalso(tabelas: Record<string, { data: unknown; error: { message: string } | null }>) {
  return {
    from(tabela: string) {
      let resposta = tabelas[tabela] ?? { data: [], error: null };
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        is: (coluna: string, valor: unknown) => {
          if (Array.isArray(resposta.data)) {
            resposta = {
              ...resposta,
              data: resposta.data.filter((linha) => (linha as Record<string, unknown>)[coluna] === valor),
            };
          }
          return cadeia;
        },
        then: (resolve: (valor: unknown) => void) => resolve(resposta),
      };
      return cadeia;
    },
  } as unknown as SupabaseClient;
}

function agente(id: string, publicado: string | null = null, arquivado = false) {
  return { id, published_version_id: publicado, archived_at: arquivado ? "2026-01-01T00:00:00Z" : null };
}

function versao(id: string, agentId: string, status: string, ligada: boolean) {
  return { id, agent_id: agentId, status, cases_enabled: ligada };
}

const ADMIN = { podeVerAgente: true, podeEditar: true };
const GESTOR = { podeVerAgente: true, podeEditar: false };
const ATENDENTE = { podeVerAgente: false, podeEditar: false };

describe("lerLiberacaoDeCasos — quem consegue abrir caso nesta organização", () => {
  it("um agente publicado com a chave ligada basta: a fila pode receber caso", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1"), agente("a2", "v2")], error: null },
      ai_agent_versions: {
        data: [versao("v1", "a1", "published", false), versao("v2", "a2", "published", true)],
        error: null,
      },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");

    expect(liberacao.estado).toBe("ligada");
    // E isso vira AUSÊNCIA de aviso: não se manda ligar o que já está ligado.
    expect(avisoDeVazioDeCasos(liberacao, ADMIN)).toBeNull();
  });

  it("todos desligados: desligada, com o agente único como alvo do link direto", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1")], error: null },
      ai_agent_versions: { data: [versao("v1", "a1", "published", false)], error: null },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");
    const aviso = avisoDeVazioDeCasos(liberacao, ADMIN);

    expect(liberacao).toMatchObject({ estado: "desligada", rascunhoLigado: false, agenteUnicoId: "a1", agentes: 1 });
    expect(aviso).toEqual({
      motivo: "chave_desligada",
      href: "/app/ai/agents/a1#cases_enabled",
      alvo: "agente",
      podeEditar: true,
    });
  });

  it("vários agentes desligados: o link vai para a lista, não para um escolhido a dedo", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1"), agente("a2", "v2")], error: null },
      ai_agent_versions: {
        data: [versao("v1", "a1", "published", false), versao("v2", "a2", "published", false)],
        error: null,
      },
    });

    const aviso = avisoDeVazioDeCasos(await lerLiberacaoDeCasos(client, "org-1"), ADMIN);

    expect(aviso).toMatchObject({ motivo: "chave_desligada", alvo: "lista", href: "/app/ai/agents" });
  });

  it("ligada só no RASCUNHO: falta publicar (conselho diferente de 'ligue a chave')", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1")], error: null },
      ai_agent_versions: {
        data: [versao("v1", "a1", "published", false), versao("v2", "a1", "draft", true)],
        error: null,
      },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");

    expect(liberacao.estado).toBe("desligada");
    expect(liberacao.rascunhoLigado).toBe(true);
    expect(avisoDeVazioDeCasos(liberacao, ADMIN)?.motivo).toBe("falta_publicar");
  });

  it("agente arquivado não conta: nem o publicado dele, nem o rascunho dele", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1", true), agente("a2", "v2")], error: null },
      ai_agent_versions: {
        data: [versao("v1", "a1", "published", true), versao("v2", "a2", "published", false)],
        error: null,
      },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");

    expect(liberacao.estado).toBe("desligada");
    expect(liberacao.agenteUnicoId).toBe("a2");
  });

  it("organização sem agente: motivo próprio, em vez de acusar uma chave que não existe", async () => {
    const client = clienteFalso({
      ai_agents: { data: [], error: null },
      ai_agent_versions: { data: [], error: null },
    });

    const aviso = avisoDeVazioDeCasos(await lerLiberacaoDeCasos(client, "org-1"), ADMIN);

    expect(aviso?.motivo).toBe("sem_agente");
  });

  it("erro de leitura não vira acusação: indefinida, nenhum aviso e rastro no log", async () => {
    erroDeLog.mockClear();
    const client = clienteFalso({
      ai_agents: { data: null, error: { message: "relation does not exist" } },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");

    expect(liberacao).toEqual(LIBERACAO_INDEFINIDA);
    expect(avisoDeVazioDeCasos(liberacao, ADMIN)).toBeNull();
    expect(erroDeLog).toHaveBeenCalledTimes(1);
  });

  it("papel sem acesso à tela do agente não recebe link (seria 403 disfarçado de ajuda)", async () => {
    const client = clienteFalso({
      ai_agents: { data: [agente("a1", "v1")], error: null },
      ai_agent_versions: { data: [versao("v1", "a1", "published", false)], error: null },
    });

    const liberacao = await lerLiberacaoDeCasos(client, "org-1");

    expect(avisoDeVazioDeCasos(liberacao, ATENDENTE)).toMatchObject({ href: null, podeEditar: false });
    expect(avisoDeVazioDeCasos(liberacao, GESTOR)).toMatchObject({
      href: "/app/ai/agents/a1#cases_enabled",
      podeEditar: false,
    });
  });
});
