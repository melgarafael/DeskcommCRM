/**
 * A CHAVE POR ASSUNTO JURÍDICO TROCA SÓ A DESCRIÇÃO DA FERRAMENTA — E NADA MAIS.
 *
 * Seção 8 do desenho do mantenedor (comentário 5999897516 no PR #2156), com os
 * quatro casos que ele pediu. A chave mora em `ai_agent_versions.
 * handoff_legal_enabled` (padrão LIGADO) e age em UM sítio só: a descrição da
 * ferramenta `request_human_handoff`, que é onde o modelo lê "questão
 * jurídica/financeira sensível" e aprende que assunto jurídico é motivo de
 * passar a conversa.
 *
 * Os quatro casos:
 *
 * 1. chave LIGADA: a descrição é byte a byte a de antes — quem não mexer em
 *    nada não muda nada;
 * 2. chave DESLIGADA: a descrição sai sem "jurídica", mantém "questão financeira
 *    sensível" e ganha a frase nova dizendo que assunto jurídico é o trabalho
 *    normal deste atendimento;
 * 3. `handoff_tool_enabled` DESLIGADO: a ferramenta continua AUSENTE (a chave
 *    nova não ressuscita o que a irmã removeu);
 * 4. chave DESLIGADA + "quero falar com uma pessoa": a conversa ainda vai para
 *    uma pessoa — o pedido explícito (`detectHumanHandoffRequest`) não lê a
 *    chave (condição 4 do desenho), e `handoff_keywords` também não.
 *
 * Sabotagem medida: tirar a troca (ou a coluna do SELECT de `agent-config.ts`)
 * derruba estes casos — ver "O que medimos" no comentário do PR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_DEFS,
  aplicaAChaveDeAssuntoJuridico,
  descricaoDaFerramentaDePassagem,
} from "@/lib/agent-engine/agent/inbound-turn";
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";

const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Um conjunto de tools no formato do turno: `execute` é o que não pode sumir. */
function ferramentas(description: string): Record<string, unknown> {
  return {
    get_lead_context: { description: "outra ferramenta", execute: () => "contexto" },
    request_human_handoff: { description, execute: () => "passou" },
  };
}

const DESCRICAO_LIGADA = AGENT_TOOL_DEFS.request_human_handoff.description as string;

describe("caso 1 — chave ligada: a descrição fica igual à de hoje", () => {
  it("byte a byte com o texto que já existia (contém 'questão jurídica/financeira sensível')", () => {
    const tools = ferramentas(DESCRICAO_LIGADA);
    aplicaAChaveDeAssuntoJuridico(tools, true);
    expect(tools.request_human_handoff).toMatchObject({ description: DESCRICAO_LIGADA });
    expect(DESCRICAO_LIGADA).toContain("questão jurídica/financeira sensível");
  });

  it("a descrição estática do módulo é a da função do lado ligado (uma fonte só)", () => {
    expect(descricaoDaFerramentaDePassagem(true)).toBe(DESCRICAO_LIGADA);
  });

  it("chave ausente em fixture antiga conta como ligada — lado seguro", () => {
    const tools = ferramentas(DESCRICAO_LIGADA);
    aplicaAChaveDeAssuntoJuridico(tools, undefined);
    expect(tools.request_human_handoff).toMatchObject({ description: DESCRICAO_LIGADA });
  });
});

describe("caso 2 — chave desligada: sem 'jurídica' e com a frase nova", () => {
  it("tira a passagem por 'questão jurídica' e diz que assunto jurídico é o trabalho normal", () => {
    const tools = ferramentas(DESCRICAO_LIGADA);
    aplicaAChaveDeAssuntoJuridico(tools, false);
    const depois = (tools.request_human_handoff as { description: string }).description;

    expect(depois, "a descrição desligada ainda manda passar por questão jurídica").not.toContain(
      "jurídica",
    );
    expect(depois).toContain(
      "assunto jurídico é o trabalho normal deste atendimento e não é, sozinho, motivo para passar a conversa",
    );
    // O resto da instrução continua: reclamação séria, financeira sensível,
    // pedido da pessoa e limite. O desenho tira SÓ o jurídico.
    expect(depois).toContain("reclamação séria");
    expect(depois, "a descrição desligada perdeu a passagem por questão financeira").toContain(
      "questão financeira sensível",
    );
    expect(depois).toContain("o limite do que pode resolver");
  });

  it("troca SÓ a descrição: execute e as demais ferramentas ficam intactos", () => {
    const tools = ferramentas(DESCRICAO_LIGADA);
    aplicaAChaveDeAssuntoJuridico(tools, false);
    expect(Object.keys(tools).sort()).toEqual(["get_lead_context", "request_human_handoff"]);
    expect(tools.get_lead_context).toEqual({
      description: "outra ferramenta",
      execute: expect.any(Function),
    });
    expect((tools.request_human_handoff as { execute: () => string }).execute()).toBe("passou");
  });
});

describe("caso 3 — handoff_tool_enabled desligado: a ferramenta continua ausente", () => {
  it("sem a ferramenta no conjunto, a chave nova não cria nada", () => {
    const semFerramenta: Record<string, unknown> = {
      get_lead_context: { description: "outra ferramenta", execute: () => "contexto" },
    };
    aplicaAChaveDeAssuntoJuridico(semFerramenta, false);
    expect(semFerramenta.request_human_handoff).toBeUndefined();
    expect(Object.keys(semFerramenta)).toEqual(["get_lead_context"]);
  });

  it("no turno, a remoção da irmã acontece ANTES da troca (ordem no fonte)", () => {
    const turno = fonte("lib/agent-engine/agent/inbound-turn.ts");
    const remove = turno.indexOf("delete rawTools.request_human_handoff;");
    const troca = turno.indexOf("aplicaAChaveDeAssuntoJuridico(rawTools,");
    expect(remove, "o ponto que remove a ferramenta sumiu do turno").toBeGreaterThan(-1);
    expect(troca, "a chamada da chave nova sumiu do turno").toBeGreaterThan(-1);
    expect(remove).toBeLessThan(troca);
    // A remoção continua amarrada à irmã `handoffToolEnabled`, não à chave nova.
    expect(turno).toMatch(/!agentConfig\.handoffToolEnabled[\s\S]{0,120}delete rawTools\.request_human_handoff/);
  });
});

describe("caso 4 — chave desligada e pedido explícito: a conversa ainda vai para uma pessoa", () => {
  it("'quero falar com uma pessoa' continua sendo detectado (condição 4)", () => {
    expect(detectHumanHandoffRequest("Quero falar com uma pessoa, por favor")).toBe(true);
    expect(detectHumanHandoffRequest("me passa para um atendente")).toBe(true);
  });

  it("o detector e as palavras de passagem não leem a chave nova", () => {
    const handoff = fonte("lib/agent-engine/agent/human-handoff.ts");
    expect(handoff).not.toMatch(/handoff_legal|handoffLegal/);
    expect(handoff, "as palavras de passagem mudaram de preço").toContain("HUMAN_HANDOFF_PATTERNS");

    // O corpo da troca só mexe em `request_human_handoff` — nem nas keywords nem
    // no detector.
    const turno = fonte("lib/agent-engine/agent/inbound-turn.ts");
    const corpo = /export function aplicaAChaveDeAssuntoJuridico\([\s\S]*?\n\}/.exec(turno)?.[0];
    expect(corpo, "não achei o corpo da troca no turno").toBeTruthy();
    expect(corpo).not.toContain("handoff_keywords");
    expect(corpo).not.toContain("detectHumanHandoffRequest");
  });
});

describe("a leitura da coluna chega do banco até o turno", () => {
  it("agent-config.ts: SELECT, Row e mapeamento trazem handoff_legal_enabled", () => {
    const config = fonte("lib/agent-engine/agent/agent-config.ts");
    expect(config, "o SELECT não lê a coluna — a chave nunca chega ao turno").toContain(
      "v.handoff_legal_enabled",
    );
    expect(config).toMatch(/handoff_legal_enabled:\s*boolean;/);
    expect(config).toContain("handoffLegalEnabled: r.handoff_legal_enabled");
    // Como a irmã, lida no MESMO SELECT que a versão publicada.
    expect(config).toContain("v.handoff_tool_enabled,\n            v.handoff_legal_enabled,");
  });
});
