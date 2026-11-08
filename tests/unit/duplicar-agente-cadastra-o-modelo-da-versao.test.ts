/**
 * A cópia de um agente nasce sem versão publicada, e o cartão da lista lê
 * `ai_agents.model` nesse caso. A duplicação copiava o `model` da LINHA de
 * origem — o do dia em que a origem foi criada, que editar/publicar a versão não
 * sincroniza. Resultado medido em produção: origem em "openai · gpt-…", cópia
 * anunciada como "anthropic · claude-sonnet-4-6", e o editor (que lê a versão)
 * mostrando o certo.
 */
import { describe, expect, it } from "vitest";

import { modeloDoCadastroDaCopia } from "@/lib/ai/agents/duplicate";
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
