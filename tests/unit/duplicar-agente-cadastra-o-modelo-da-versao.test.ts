/**
 * A cópia de um agente nasce sem versão publicada, e o cartão da lista lê
 * `ai_agents.model` nesse caso. A duplicação copiava o `model` da LINHA de
 * origem — o do dia em que a origem foi criada, que editar/publicar a versão não
 * sincroniza. Resultado medido em produção: origem em "openai · gpt-…", cópia
 * anunciada como "anthropic · claude-sonnet-4-6", e o editor (que lê a versão)
 * mostrando o certo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/pontos/provedores-oferecidos", () => ({
  MENSAGEM_PROVEDOR_DESLIGADO: "provedor desligado",
  provedorDesligadoNaInstalacao: async () => false,
}));

import { duplicateAgentWithVersion, modeloDoCadastroDaCopia } from "@/lib/ai/agents/duplicate";
import { modeloEmVigor } from "@/app/app/ai/agents/_components/AgentCard";
import type { AgentRow } from "@/hooks/ai/useAgent";

const origem = { model: "anthropic/claude-sonnet-4-6" };

describe("duplicar agente — o cadastro da cópia diz o modelo da versão copiada", () => {
  it("usa provedor/modelo da versão, não o cadastro velho da origem", () => {
    expect(modeloDoCadastroDaCopia(origem, { provider: "openai", model: "gpt-5.1" })).toBe(
      "openai/gpt-5.1",
    );
  });

  it("o cartão da cópia (sem versão publicada) anuncia o modelo da versão", () => {
    const model = modeloDoCadastroDaCopia(origem, { provider: "openai", model: "gpt-5.1" });
    const copia = { model, versao_publicada: null } as unknown as AgentRow;
    expect(modeloEmVigor(copia)).toBe("openai · gpt-5.1");
  });

  it("sem versão (ou versão sem provedor/modelo) mantém o cadastro da origem", () => {
    expect(modeloDoCadastroDaCopia(origem, null)).toBe(origem.model);
    expect(modeloDoCadastroDaCopia(origem, { provider: "openai", model: "" })).toBe(origem.model);
    expect(modeloDoCadastroDaCopia(origem, { provider: null, model: "gpt-5.1" })).toBe(origem.model);
  });
});

/**
 * Banco de mentira, só do tamanho do caminho de duplicar: lê o agente e a
 * versão de origem e guarda o que foi INSERIDO, que é o que importa aqui.
 */
function bancoDeMentira(origem: { agente: Record<string, unknown>; versao: Record<string, unknown> }) {
  const inseridos: Record<string, Record<string, unknown>[]> = {};
  const from = (tabela: string) => {
    let modo: "ler" | "inserir" = "ler";
    let colunas = "";
    let linha: Record<string, unknown> = {};
    const q = {
      select: (c?: string) => {
        if (modo === "ler") colunas = c ?? "";
        return q;
      },
      eq: () => q,
      order: () => q,
      limit: () => q,
      update: () => q,
      insert: (l: Record<string, unknown>) => {
        modo = "inserir";
        linha = { id: `${tabela}-novo`, ...l };
        (inseridos[tabela] ??= []).push(l);
        return q;
      },
      maybeSingle: async () => ({
        data: tabela === "ai_agents" ? origem.agente : origem.versao,
        error: null,
      }),
      single: async () => ({ data: linha, error: null }),
      // `select("name")` sem terminal: a lista de nomes ocupados.
      then: (ok: (v: unknown) => unknown) =>
        ok({ data: modo === "ler" && colunas === "name" ? [{ name: origem.agente.name }] : null, error: null }),
    };
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, inseridos };
}

describe("duplicar agente — a GRAVAÇÃO usa o modelo da versão", () => {
  it("a linha inserida em ai_agents leva provedor/modelo da versão copiada", async () => {
    const { admin, inseridos } = bancoDeMentira({
      agente: { id: "a1", name: "Vendas", kind: "mcp_agent", model: "anthropic/claude-sonnet-4-6" },
      versao: { id: "v1", provider: "openai", model: "gpt-5.1", status: "draft" },
    });

    const r = await duplicateAgentWithVersion(admin, {
      orgId: "org-1",
      agentId: "a1",
      actorUserId: "u1",
      requireVersion: true,
    });

    expect(r.ok).toBe(true);
    expect(inseridos.ai_agents?.[0]?.name).toBe("Vendas (cópia)");
    expect(inseridos.ai_agents?.[0]?.model).toBe("openai/gpt-5.1");
    expect(inseridos.ai_agent_versions?.[0]?.model).toBe("gpt-5.1");
  });
});
