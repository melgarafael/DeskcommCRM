import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O GANCHO DE EXTENSÃO ESTÁ *NO TURNO*, E NO LUGAR CERTO (#3076).
 *
 * Esta é a prova de FIÇÃO do ponto: o comportamento do gancho tem teste próprio
 * (`lib/agent-engine/agent/gancho-de-extensao.test.ts`), e o vocabulário
 * declarativo também (`lib/extensions/fluxo-do-turno.test.ts`). O que só o TEXTO
 * do turno pode provar é o que a issue pede no item 1:
 *
 *   "Depois de todos os silenciadores (passagem humana ativa, agente pausado,
 *    pedido de humano, opt-out) e antes do roteiro de atendimento e da IA."
 *
 * É a mesma técnica do `roteiro-no-turno.test.ts` (achado 5 do #1130), e ela
 * existe porque o defeito medido lá foi de ORDEM: o roteiro abria para quem
 * tinha pedido para parar. Um teste de unidade da função não pega isso — ele
 * nunca vê o turno.
 */

const src = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

const chamada = src.indexOf("await prepararGanchoDoTurno(");
/** O bloco INTEIRO do gancho: da chamada até o comentário do roteiro. */
const blocoDoGancho = (): string => {
  const fim = src.indexOf("// ROTEIRO DE ATENDIMENTO (módulo opcional");
  return fim > chamada ? src.slice(chamada, fim) : src.slice(chamada);
};

describe("o gancho entra no turno do agente", () => {
  it("o turno CHAMA o gancho (sem esta chamada o resto do teste não tem o que vigiar)", () => {
    expect(chamada).toBeGreaterThan(0);
  });

  it("a chamada lê as extensões ATIVAS da organização e o turno (nunca uma lista do servidor)", () => {
    const trecho = blocoDoGancho();
    expect(trecho).toContain("lerFluxosAtivosDaOrganizacao(pool, tenantId, runLog)");
    expect(trecho).toContain("organizationId: tenantId");
    expect(trecho).toContain("conversationId: input.conversationId");
    // O claim é da MENSAGEM do turno — é o que torna o retry no-op (item 4).
    expect(trecho).toContain("messageId: input.inboundMessageId ?? null");
  });

  it("⭐ vem DEPOIS de todos os silenciadores", () => {
    for (const trava of [
      "agentConfig.pausedAt",
      "detectHumanHandoffRequest(texto)",
      "detectAmbiguousOptOut(texto)",
      "isLeadInHandoff(pool, tenantId, leadId)",
      // Opt-out registrado na fonte: o gancho não roda para contato bloqueado.
      "const optedOutThisTurn",
    ]) {
      const posicao = src.indexOf(trava);
      expect(posicao, `trava ausente no turno: ${trava}`).toBeGreaterThan(0);
      expect(posicao, `o gancho entrou ANTES de ${trava}`).toBeLessThan(chamada);
    }
  });

  it("⭐ vem ANTES do roteiro de atendimento, que já era o ponto mais adiantado", () => {
    // Sem a chamada, `-1` seria "antes de tudo" e o teste passaria verde sobre
    // nada — o guarda abaixo impede que esta prova se satisfaça com a ausência.
    expect(chamada).toBeGreaterThan(0);
    const roteiro = src.indexOf("await prepararRoteiroDoTurno(");
    expect(roteiro).toBeGreaterThan(0);
    expect(chamada).toBeLessThan(roteiro);
  });

  it("⭐ vem ANTES da IA (a primeira chamada de modelo do turno)", () => {
    expect(chamada).toBeGreaterThan(0);
    const modelo = src.indexOf("await runModelCall(");
    expect(modelo).toBeGreaterThan(0);
    expect(chamada).toBeLessThan(modelo);
  });

  it("nunca roda na PRÉVIA (Testar do agente) nem fora do turno inbound", () => {
    expect(chamada).toBeGreaterThan(0);
    const trecho = src.slice(Math.max(0, chamada - 700), chamada);
    expect(trecho).toContain("if (!preview && liveJob().kind === 'inbound_turn' && !optedOutThisTurn)");
  });

  it("⭐ quando a extensão assume ou passa, a IA NÃO roda neste turno (return cedo)", () => {
    // Do início da chamada até o comentário do roteiro: a janela inteira do
    // bloco do gancho, sem contar caracteres.
    const fim = src.indexOf("// ROTEIRO DE ATENDIMENTO (módulo opcional");
    expect(fim).toBeGreaterThan(chamada);
    const trecho = src.slice(chamada, fim);
    expect(trecho).toContain(
      "if (gancho.tipo === 'assumido' || gancho.tipo === 'passado' || gancho.tipo === 'ja_tratado')",
    );
    const posicaoReturn = trecho.indexOf("return;", trecho.indexOf("gancho.tipo === 'assumido'"));
    expect(posicaoReturn).toBeGreaterThan(0);
  });

  it("a bolha da extensão sai pela cadeia do núcleo, com 'digitando' antes dela (item 6)", () => {
    expect(chamada).toBeGreaterThan(0);
    const trecho = blocoDoGancho();
    expect(trecho).toContain("enviarTextoSemModelo(");
    expect(trecho).toContain("channel: liveChannel()");
    // O mesmo helper do aviso marca presença e passa `runBeforeSend`: nada aqui
    // fala com o canal por baixo da cadeia.
    const helper = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/gancho-de-extensao.ts"),
      "utf8",
    );
    expect(helper).toContain("await runBeforeSend(");
    expect(helper).toContain("signalTyping");
  });

  it("o 'passo para humano' usa a passagem com os campos coletados (c3 do #3052), não texto na Central", () => {
    expect(chamada).toBeGreaterThan(0);
    const trecho = blocoDoGancho();
    expect(trecho).toContain("camposColetados: campos");
    // A chave de idempotência é a mensagem reivindicada — o retry não duplica a
    // linha da passagem (portado do #3063).
    expect(trecho).toContain("idempotenciaDaPassagem: idempotencia");
    expect(trecho).toContain("performHumanHandoff(");
  });
});
