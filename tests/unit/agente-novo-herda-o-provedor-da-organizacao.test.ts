/**
 * O AGENTE NOVO NASCE NO PROVEDOR DA ORGANIZAÇÃO, NÃO EM ANTHROPIC.
 *
 * MEDIDO numa instalação fresca (issue #1694, item 2): `settings.llm.provider
 * = openai` — a organização só tem chave da OpenAI —, e o formulário de agente
 * novo abria em Anthropic (Claude), oferecendo "Cadastrar credencial
 * anthropic" para quem não tem essa chave.
 *
 * Três degraus, um por caso: o provedor que a página passa (a organização),
 * o que acontece quando ele não é opção nenhuma do seletor (o `anthropic` de
 * sempre) e a precedência da versão existente (quem já tem versão não muda de
 * cérebro ao reabrir o editor).
 */
import { describe, expect, it } from "vitest";

import { buildState, provedorInicial } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

const t = (texto: string) => texto;

describe("provedor inicial de um agente sem versão", () => {
  it("herda settings.llm.provider da organização", () => {
    const estado = buildState({ version: null, t, provedorPadrao: "openai" });
    expect(estado.provider).toBe("openai");
  });

  it("sem provedor passado, continua nascendo anthropic", () => {
    expect(provedorInicial(undefined)).toBe("anthropic");
    expect(buildState({ version: null, t }).provider).toBe("anthropic");
  });

  it("provedor que o seletor não oferece cai no anthropic, não em branco", () => {
    // `settings` é jsonb gravado por várias telas: um id fora de `PROVEDORES`
    // viraria `<Select>` sem opção correspondente — o campo abrindo vazio e o
    // formulário pedindo para escolher de novo.
    expect(provedorInicial("provedor-que-nao-existe")).toBe("anthropic");
    expect(provedorInicial("")).toBe("anthropic");
  });

  it("a versão existente continua mandando no provedor", () => {
    const versao = { provider: "google" } as AgentVersionRow;
    const estado = buildState({ version: versao, t, provedorPadrao: "openai" });
    expect(estado.provider).toBe("google");
  });
});
