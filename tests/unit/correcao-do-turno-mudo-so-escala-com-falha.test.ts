/**
 * A correção do turno mudo só escala com SINAL DE FALHA — nunca por silêncio
 * deliberado (#2938).
 *
 * O defeito que este gate cobre: o CORRECAO_DO_TURNO_MUDO autoriza o modelo a
 * responder "nada a dizer", então um turno que termina em silêncio mesmo com a
 * correção rodada NÃO é defeito — e era exatamente isso que um caso humano
 * falso-positive marcava para o time. O desfecho terminal passou a exigir um
 * sinal de falha: a saída truncada (length) ou a correção que TAMBÉM terminou
 * truncada. Erro da chamada de correção propaga e o job falha na fila
 * (retry/dead-letter) — caminho alto que já existia.
 *
 * Cenários, na ordem em que o código os garante:
 *
 *  1. Recuperação limitada preservada: a correção continua sendo pedida sob as
 *     condições do próprio pedido (`turno-mudo.ts`) e continua sendo UMA.
 *  2. Decisão DEPOIS da correção: o desfecho terminal é avaliado com os flags
 *     e `outcomes` re-avaliados depois dela — correção que recuperou (mensagens
 *     saíram) nunca vira caso humano.
 *  3. Silêncio sem razão legítima: nada despachado, nada tentado, primeira passada.
 *  4. Isenção de silêncio legítimo: descartado, handoff da equipe, teto de
 *     pacing e preview ficam de fora — mesma régua do truncamento.
 *  5. Escala só com falha: truncamento não recuperado OU correção truncada —
 *     `correcaoDoTurnoMudoPedida` sozinho NÃO escala.
 *  6. Caso humano com `kind` de TIPOS_DE_CASO ('problema'), copy em português
 *     simples e gate `agentConfig.casesEnabled` — mesma régua dos outros
 *     fail-safes.
 *  7. Nunca duplica: o bloco terminal não despacha nada (só registra e abre
 *     caso) e `caso.ok` gateia o move do funil.
 *
 * Por que contrato de fonte (mesma técnica de saida-truncada-nao-vai-parcial.test.ts):
 * o detect fica no meio do closure do turno, sem ponto de injeção barato; o que
 * dá pra prender com segurança é a estrutura — presença, ordem e condições.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PASSOS_DA_CORRECAO } from "@/lib/agent-engine/agent/turno-mudo";

const ler = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const turno = ler("lib/agent-engine/agent/inbound-turn.ts");

// Posições de âncora (fonte única de verdade para as ordens abaixo).
const idxCorrecaoConst = turno.indexOf("const correcaoDoTurnoMudoPedida =");
const idxCorrecaoTruncou = turno.indexOf(
  "correcaoTruncou = correcao.result.finishReason === 'length';",
);
const idxCorrecaoIf = turno.indexOf("if (correcaoDoTurnoMudoPedida) {");
const idxCorrecaoExec = turno.indexOf(
  "mensagensDoTurno = [...mensagensDoTurno, pedidoDeCorrecao, ...correcao.result.responseMessages];",
);
const idxSilencio = turno.indexOf("const silencioSemRazaoLegitima =");
const idxRoteiro = turno.indexOf("ROTEIRO: a pergunta pendente");

// O bloco que decide o desfecho terminal, do começo da decisão ao fim do bloco.
const blocoTerminal = () => {
  expect(idxSilencio).toBeGreaterThan(-1);
  expect(idxRoteiro).toBeGreaterThan(idxSilencio);
  return turno.slice(idxSilencio, idxRoteiro);
};
// O bloco da correção limitada, do `if` à decisão terminal.
const blocoCorrecao = () => {
  expect(idxCorrecaoIf).toBeGreaterThan(-1);
  expect(idxSilencio).toBeGreaterThan(idxCorrecaoIf);
  return turno.slice(idxCorrecaoIf, idxSilencio);
};

describe("recuperação limitada do turno mudo (preservada)", () => {
  it("a correção é pedida sob as condições do pedido e o valor é capturado ANTES de rodar", () => {
    expect(idxCorrecaoConst).toBeGreaterThan(-1);
    expect(idxCorrecaoConst).toBeLessThan(idxCorrecaoIf);
    // Reusa a régua do próprio pedido — razões legítimas de silêncio nem
    // chegam a corrigir (turno-mudo.ts é a definição única).
    const cabeca = turno.slice(idxCorrecaoConst, idxCorrecaoIf);
    expect(cabeca).toContain("turnoMudoPedeCorrecao({");
    expect(cabeca).toContain("enviadas: outcomes.length,");
    expect(cabeca).toContain("liveJob().kind === 'inbound_turn'");
    // O sinal de falha da correção é declarado junto com o pedido, falso por
    // padrão (logo acima da const) — silêncio deliberado não nasce escalado.
    const idxCorrecaoTruncouDecl = turno.indexOf("let correcaoTruncou = false;");
    expect(idxCorrecaoTruncouDecl).toBeGreaterThan(-1);
    expect(idxCorrecaoTruncouDecl).toBeLessThan(idxCorrecaoConst);
  });

  it("a correção continua UMA só — um único runModelCall, steps limitados", () => {
    const bloco = blocoCorrecao();
    expect(bloco.split("await runModelCall(").length - 1).toBe(1);
    // O teto é 6, e não 3: medido no teste 10 do aceite (2026-10-26, job
    // 5ca40cb3) a correção com 3 passos gastou OS TRÊS em ferramentas de agenda
    // (crm_list_event_types → crm_find_free_slots → crm_find_and_book_appointment)
    // e parou antes de chegar ao send_message — `messages_sent: 0`, cliente sem
    // resposta. Uma remarcação correta são 4 saídas de modelo (localizar com
    // crm_list_appointments → slot → crm_reschedule_appointment → send_message);
    // com teto 3 ela é aritmeticamente impossível. O limite CONTINUA existindo
    // (correção é UMA e limitada) — só é folgado o bastante para a receita caber.
    expect(PASSOS_DA_CORRECAO).toBe(6);
    // O MESMO teto roda a correção E mede se ela bateu nele (`tetoNaCorrecao`):
    // com dois literais, a régua ficou em 3 enquanto a correção rodava com 6.
    expect(bloco.split("Math.min(maxSteps, PASSOS_DA_CORRECAO)").length - 1).toBe(2);
    expect(bloco).not.toMatch(/Math\.min\(maxSteps, \d+\)/);
    // O pedido de correção é a instrução canônica do motor.
    expect(bloco).toContain("CORRECAO_DO_TURNO_MUDO");
    // Nenhum desfecho terminal dentro da correção — decisão é separada.
    expect(bloco).not.toContain("output_truncated_recovered_failed");
    expect(bloco).not.toContain("openCase(");
  });
});

describe("decisão terminal: DEPOIS da correção, com os flags re-avaliados", () => {
  it("a ordem é: pedir correção → executar → medir a falha → decidir o desfecho", () => {
    expect(idxCorrecaoConst).toBeLessThan(idxCorrecaoIf);
    expect(idxCorrecaoIf).toBeLessThan(idxCorrecaoTruncou);
    expect(idxCorrecaoTruncou).toBeLessThan(idxCorrecaoExec);
    // A decisão lê `outcomes`/flags DEPOIS da correção rodar: recuperação
    // bem-sucedida (mensagens saíram) é vista como `outcomes.length > 0`.
    expect(idxCorrecaoExec).toBeLessThan(idxSilencio);
  });

  it("o sinal de falha da correção é o finishReason dela: truncada (length)", () => {
    const bloco = blocoCorrecao();
    expect(bloco).toContain("correcaoTruncou = correcao.result.finishReason === 'length';");
  });

  it("silêncio sem razão legítima: nada despachado, nada tentado, primeira passada", () => {
    const bloco = blocoTerminal();
    // Proteção por mensagem existente: quem já despachou (ou tentou e levou
    // veto — o veto é a razão e já ensinou) não escala a caso humano.
    expect(bloco).toContain("outcomes.length === 0");
    expect(bloco).toContain("tentativasDeEnvio === 0");
    expect(bloco).toContain("seq === 0");
    expect(bloco).toContain("!preview");
  });

  it("isenta silêncio legítimo: descartado, handoff da equipe e teto de pacing", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("!turnoDescartado");
    expect(bloco).toContain("!passouParaAEquipe");
    expect(bloco).toContain("!capDeEnvioAtingido()");
  });

  it("só escala com sinal de FALHA: truncamento OU correção truncada — nunca por ter corrigido", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain(
      "if (silencioSemRazaoLegitima && (saidaTruncada || correcaoTruncou)) {",
    );
    // O gatilho antigo — correção apenas PEDIDA — é exatamente o regresso que
    // fazia silêncio deliberado abrir caso à toa.
    expect(bloco).not.toMatch(
      /silencioSemRazaoLegitima && \(saidaTruncada \|\| correcaoDoTurnoMudoPedida\)/,
    );
  });
});

describe("desfecho distinto, caso humano único, nunca duplica", () => {
  it("causa vira código próprio: truncada ≠ correção truncada (truncamento preservado)", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("const desfechoTerminal = saidaTruncada");
    expect(bloco).toContain("? 'output_truncated_recovered_failed'");
    expect(bloco).toContain(": 'correction_truncated_failed';");
    // O mesmo mecanismo suportado de caso humano, com a causa no snapshot.
    expect(bloco).toContain("openCase(");
    expect(bloco).toContain("source: 'guardrail_autofallback'");
    expect(bloco).toContain("correcao_limitada_rodou: correcaoDoTurnoMudoPedida");
    expect(bloco).toContain("correcao_truncou: correcaoTruncou");
  });

  it("caso com `kind` de TIPOS_DE_CASO e copy em português simples (sem código de máquina)", () => {
    const bloco = blocoTerminal();
    // `kind: 'problema'` vem do vocabulário do product (case-copy.ts) — um kind
    // inventado faz a tela do time mostrar "Outro".
    expect(bloco).toContain("kind: 'problema'");
    // blocker/summary são exibidos ao time ("Por que a IA travou"/"O que o
    // cliente precisa") — nenhum rótulo de máquina neles.
    expect(bloco).not.toContain("saida_truncada");
    expect(bloco).not.toContain("finish_reason=length");
  });

  it("casesEnabled gateia o caso — mesma régua dos fail-safes clínico e de promessa", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("agentConfig?.casesEnabled === true");
    expect(bloco).toContain("!openedCaseThisTurn");
    expect(bloco).toContain("hasOpenCaseForContact(pool, tenantId, input.conversationId)");
    // A FALHA continua visível pelo log mesmo com cases desligados.
    expect(bloco).toContain("runLog.error(`${desfechoTerminal} — sem nenhuma mensagem entregue`");
  });

  it("um caso por turno: `caso.ok` gateia o move do funil e a falha fica visível", () => {
    const bloco = blocoTerminal();
    expect(bloco).toContain("if (caso.ok) {");
    expect(bloco).toContain("openedCaseThisTurn = true;");
    expect(bloco).toContain("moverParaHandoffBestEffort(desfechoTerminal);");
    // Caso já aberto → log distinto, sem segundo move; openCase que lançou
    // também fica visível (não engole a causa original).
    expect(bloco).toContain("caso humano não abriu (já existe)");
    expect(bloco).toContain("openCase lançou");
  });

  it("o bloco terminal não despacha nada — nunca duplica mensagem nem re-tenta envio", () => {
    const bloco = blocoTerminal();
    expect(bloco).not.toContain("await runModelCall(");
    expect(bloco).not.toContain("runBeforeSend");
    expect(bloco).not.toContain("sendTurnMessage");
  });
});
