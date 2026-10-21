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
  corpoTemTexto,
  lerFiltroDePalavraChave,
  turnoDisparaNaPalavraChave,
  turnoDisparaNasMensagens,
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
    expect(turnoDisparaNaPalavraChave(filtro, "camiseta azul, tamanho M")).toBe(false);
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

  it("MÍDIA chega como `[audio]`/`[image]`, não como null — e também falha ABERTA", () => {
    // O CR do mantenedor no #2696 mediu o buraco: em produção
    // `loadInboundBodyForJob`/`corpoDaMensagem` NUNCA devolvem `null` para
    // mídia — devolvem o marcador do tipo. Com `corpo === null` como régua, a
    // falha aberta acima nunca rodava e o áudio sem transcrição era calado
    // pelo filtro.
    for (const marcador of ["[audio]", "[image]", "[document]", "[video]"]) {
      expect(turnoDisparaNaPalavraChave(filtro, marcador), marcador).toBe(true);
    }
  });

  it("mídia COM derivado é julgada pelo texto transcrito (a régua do roteador)", () => {
    // `corpoDaMensagem` enquadra o derivado (`[Mídia do cliente: …]`); a partir
    // daí há TEXTO — e um áudio que não fala de orçamento não entra, como
    // qualquer outra mensagem. É a outra metade da régua: sem `body` E sem
    // `media_derived_text` é que é "sem texto".
    const transcrito =
      "[Mídia do cliente: ele enviou um áudio e o sistema já processou o conteúdo pra você.]\n" +
      "Conteúdo: oi, tudo bem?";
    expect(turnoDisparaNaPalavraChave(filtro, transcrito)).toBe(false);
    expect(corpoTemTexto(transcrito)).toBe(true);
  });

  it("corpo vazio/whitespace é 'sem texto' — nada a casar não é 'não casou'", () => {
    // `''` só aparece quando a linha não tem texto NEM mídia; tratar como miss
    // barraria uma mensagem que o cliente não escreveu, que é a mesma direção
    // errada do caso da mídia.
    expect(turnoDisparaNaPalavraChave(filtro, "")).toBe(true);
    expect(turnoDisparaNaPalavraChave(filtro, "   ")).toBe(true);
  });
});

describe("corpoTemTexto", () => {
  it("texto de gente tem texto", () => {
    expect(corpoTemTexto("quero um orçamento")).toBe(true);
    expect(corpoTemTexto("  [audio] do cliente falando de preço")).toBe(true);
  });

  it("nulo, vazio, whitespace e o marcador de mídia não têm", () => {
    expect(corpoTemTexto(null)).toBe(false);
    expect(corpoTemTexto("")).toBe(false);
    expect(corpoTemTexto(" \n ")).toBe(false);
    expect(corpoTemTexto("[audio]")).toBe(false);
    expect(corpoTemTexto("[IMAGE]")).toBe(false);
    expect(corpoTemTexto(" [audio] ")).toBe(false);
  });
});

describe("turnoDisparaNasMensagens — a RAJADA é julgada pelo conjunto (#2696, ponto 3)", () => {
  const filtro = lerFiltroDePalavraChave(triggerCom("orçamento|pedido"));

  it("'oi' + 'quero um orçamento' entra: o drain coalesce a 2ª no job da 1ª", () => {
    // Medido com o portão lendo só a mensagem fixada: a rajada era descartada
    // inteira, e o cliente que pediu orçamento ficava sem resposta.
    expect(turnoDisparaNaPalavraChave(filtro, "oi")).toBe(false);
    expect(turnoDisparaNasMensagens(filtro, ["oi", "quero um orçamento"])).toBe(true);
  });

  it("nenhuma mensagem da rajada casa ⇒ não entra", () => {
    expect(turnoDisparaNasMensagens(filtro, ["oi", "camiseta azul, tamanho M"])).toBe(false);
  });

  it("mídia sem texto em qualquer mensagem da rajada falha ABERTA", () => {
    // Cada mensagem é julgada sozinha — a régua da mídia não pode depender de
    // quem mais veio na rajada.
    expect(turnoDisparaNasMensagens(filtro, ["camiseta azul", "[audio]"])).toBe(true);
  });

  it("lista vazia (nada a julgar) falha ABERTA e sem filtro entra sempre", () => {
    expect(turnoDisparaNasMensagens(filtro, [])).toBe(true);
    expect(turnoDisparaNasMensagens(null, ["oi"])).toBe(true);
  });
});
