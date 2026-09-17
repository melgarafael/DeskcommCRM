/**
 * O vocabulário de assunto do caso vive num lugar só.
 *
 * A coluna `agent_cases.kind` é `text` SEM CHECK (doutrina de vocabulário aberto
 * do CLAUDE.md), então o banco não segura nada — quem segura é `TIPOS_DE_CASO`.
 * Se a lista que a IA pode escolher divergir da que a tela sabe rotular, o
 * sintoma é um caso classificado que aparece como "Outro" para sempre, sem erro
 * em lugar nenhum.
 */
import { describe, expect, it } from "vitest";

import { openHumanCaseInputSchema } from "@/lib/agent-engine/agent/human-cases";

import { TIPOS_DE_CASO, TIPOS_DE_CASO_PARA_A_IA, tipoDeCasoLabel } from "./case-copy";

describe("vocabulário de assunto do caso", () => {
  it("todo tipo tem rótulo para a tela E orientação para a IA", () => {
    for (const k of Object.keys(TIPOS_DE_CASO)) {
      expect(TIPOS_DE_CASO[k as keyof typeof TIPOS_DE_CASO], k).toBeTruthy();
      expect(TIPOS_DE_CASO_PARA_A_IA[k as keyof typeof TIPOS_DE_CASO], k).toBeTruthy();
    }
    // Sem tipo órfão do outro lado.
    expect(Object.keys(TIPOS_DE_CASO_PARA_A_IA).sort()).toEqual(Object.keys(TIPOS_DE_CASO).sort());
  });

  it("a tool aceita exatamente os tipos da fonte — nem mais, nem menos", () => {
    for (const k of Object.keys(TIPOS_DE_CASO)) {
      const r = openHumanCaseInputSchema.safeParse({
        title: "t",
        summary: "s",
        blocker: "b",
        kind: k,
      });
      expect(r.success, `a tool recusou "${k}", que está no vocabulário`).toBe(true);
    }
  });

  it("tipo inventado pelo modelo é recusado", () => {
    // Vocabulário aberto no BANCO não significa aberto na TOOL: o que a IA
    // escolhe tem que estar na lista, senão a triagem vira texto livre.
    const r = openHumanCaseInputSchema.safeParse({
      title: "t",
      summary: "s",
      blocker: "b",
      kind: "reclamacao_de_unha",
    });
    expect(r.success).toBe(false);
  });

  it("o tipo é OPCIONAL — classificar nunca pode impedir o pedido de chegar", () => {
    // Modelo antigo, clone com prompt diferente, ou o fail-safe do guardrail:
    // todos continuam abrindo caso. Recusar por falta de classificação seria
    // perder o pedido do cliente por causa de uma conveniência de triagem.
    const r = openHumanCaseInputSchema.safeParse({ title: "t", summary: "s", blocker: "b" });
    expect(r.success).toBe(true);
  });

  it("valor desconhecido no banco cai no genérico, nunca quebra a tela", () => {
    // Um clone com engine mais novo, ou um caso classificado antes de alguém
    // encurtar a lista.
    expect(tipoDeCasoLabel("tipo_que_nao_existe")).toBe(TIPOS_DE_CASO.outro);
    expect(tipoDeCasoLabel("")).toBe(TIPOS_DE_CASO.outro);
    expect(tipoDeCasoLabel("agendamento")).toBe(TIPOS_DE_CASO.agendamento);
  });

  it("a lista é curta — muitas categorias produzem classificação inconsistente", () => {
    // Não é preciosismo: o detalhe já mora em `title`/`summary`. Uma lista longa
    // faria o modelo escolher diferente para o mesmo pedido em dias diferentes,
    // e aí o filtro atrapalha em vez de ajudar. Se alguém quiser crescer, que
    // seja uma decisão consciente — e não um item por pedido de cliente.
    expect(Object.keys(TIPOS_DE_CASO).length).toBeLessThanOrEqual(8);
  });
});
