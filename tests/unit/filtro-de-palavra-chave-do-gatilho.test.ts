/**
 * O filtro "Só responder quando a mensagem falar de algo específico"
 * (`keyword_regex`) que a tela gravava e nenhum leitor vivo consultava (#2679).
 *
 * `TriggerEditor.tsx` promete "Se preencher, ele só entra quando a mensagem
 * contiver uma dessas palavras" e grava em
 * `ai_agent_versions.trigger_config.filters.keyword_regex`. O ÚNICO leitor era
 * `lib/ai/dispatcher/triggers.ts` — dentro de `dispatchAgents`, que não tem
 * chamador fora de testes desde que o cron do dispatcher virou NO-OP (Fase 0).
 * É o mesmo defeito que `janela-de-atendimento.ts` consertou para
 * `business_hours`: controle que a tela oferece e o código ignora mente para
 * quem configurou.
 *
 * Estes testes fixam as duas metades do conserto: ler a regex sem nunca virar
 * mordaça (jsonb livre, regex torta ⇒ sem filtro ⇒ o agente responde, como
 * sempre) e a decisão de disparo — COM a keyword o turno entra, SEM ela não
 * entra, e SEM keyword preenchido nada muda (retrocompatível).
 */
import { describe, expect, it } from "vitest";

import {
  lerFiltroDePalavraChave,
  turnoDisparaNaPalavraChave,
} from "@/lib/agent-engine/agent/palavra-chave-do-gatilho";

/** Shape que `TriggerEditor` grava (via `lib/ai/agents/validation.ts`). */
const triggerCom = (keywordRegex: unknown) => ({
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: keywordRegex },
});

describe("lerFiltroDePalavraChave", () => {
  it("lê a regex gravada na versão publicada, sem diferenciar maiúscula", () => {
    const filtro = lerFiltroDePalavraChave(triggerCom("orçamento|pedido"));
    expect(filtro).not.toBeNull();
    expect(filtro?.test("quero um orçamento")).toBe(true);
    expect(filtro?.test("Tem PEDIDO em aberto?")).toBe(true);
  });

  it("sem keyword_regex preenchido é sem filtro (o agente entra em tudo)", () => {
    expect(lerFiltroDePalavraChave(triggerCom(null))).toBeNull();
    expect(lerFiltroDePalavraChave(triggerCom(""))).toBeNull();
    expect(lerFiltroDePalavraChave(triggerCom("   "))).toBeNull();
    expect(lerFiltroDePalavraChave({ events: ["message"], filters: {} })).toBeNull();
    expect(lerFiltroDePalavraChave({ events: ["message"] })).toBeNull();
    expect(lerFiltroDePalavraChave(null)).toBeNull();
    expect(lerFiltroDePalavraChave("orçamento")).toBeNull();
  });

  it("FALHA ABERTA em regex malformada — nunca vira mordaça", () => {
    // Mesma régua de `lerJanelaDeAtendimento`: config quebrada não pode calar
    // o agente para sempre. Quem errou a regex corrige na tela; quem escreveu
    // não fica sem resposta até lá.
    expect(lerFiltroDePalavraChave(triggerCom("["))).toBeNull();
    expect(lerFiltroDePalavraChave(triggerCom("(orçamento"))).toBeNull();
    expect(lerFiltroDePalavraChave(triggerCom(42))).toBeNull();
    expect(lerFiltroDePalavraChave(triggerCom({}))).toBeNull();
  });
});

describe("turnoDisparaNaPalavraChave", () => {
  const filtro = lerFiltroDePalavraChave(triggerCom("orçamento|pedido"));

  it("mensagem COM a keyword dispara o turno", () => {
    expect(turnoDisparaNaPalavraChave(filtro, "quero um orçamento")).toBe(true);
    expect(turnoDisparaNaPalavraChave(filtro, "Tem pedido em aberto?")).toBe(true);
  });

  it("mensagem SEM a keyword não dispara o turno", () => {
    expect(turnoDisparaNaPalavraChave(filtro, "oi, bom dia")).toBe(false);
    expect(turnoDisparaNaPalavraChave(filtro, "")).toBe(false);
  });

  it("sem keyword preenchido continua disparando sempre (retrocompatível)", () => {
    expect(turnoDisparaNaPalavraChave(null, "oi, bom dia")).toBe(true);
    expect(turnoDisparaNaPalavraChave(null, "")).toBe(true);
    expect(turnoDisparaNaPalavraChave(null, null)).toBe(true);
  });

  it("corpo sem texto (mídia sem legenda/transcrição) falha ABERTA — dispara", () => {
    // `body` chega NULL em áudio/foto e a transcrição só é gravada depois pelo
    // media-derive-worker (corrida do #617): barrar aqui seria calar a mídia
    // inteira por causa de uma coluna que ainda vai ser preenchida.
    expect(turnoDisparaNaPalavraChave(filtro, null)).toBe(true);
  });
});
