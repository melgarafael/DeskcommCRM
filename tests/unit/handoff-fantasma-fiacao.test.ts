import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FIAÇÃO — mesmo padrão de `gate-agenda-stall.test.ts`/`gate-vazamento-interno.test.ts`:
 * prova que os pontos de conserto do handoff "fantasma" pro gerente (achado em
 * produção — o bot dizia "vou verificar com o Fulano" repetidas
 * vezes sem nunca abrir caso nem mover o funil) estão de fato ligados na fonte,
 * não só implementados isolados.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);
const FONTE_INGEST = fs.readFileSync(path.join(process.cwd(), "lib/waha/ingest.ts"), "utf8");

describe("fiação — casePromiseGate recebe o nome do gerente do tenant", () => {
  it("send_message passa humanPromiseExtraTargets a partir de agentConfig.handoffKeywords", () => {
    const i = FONTE_INBOUND.indexOf("send_message: tool({");
    const j = FONTE_INBOUND.indexOf("update_lead_state: tool({", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const corpo = FONTE_INBOUND.slice(i, j);
    expect(corpo).toMatch(/humanPromiseExtraTargets:\s*agentConfig\?\.handoffKeywords/);
  });
});

describe("fiação — caso humano aberto move o lead pra etapa de handoff", () => {
  it("o fail-safe do case_promise (auto-abre-caso) chama moverParaHandoffBestEffort", () => {
    const i = FONTE_INBOUND.indexOf("chain.status === 'vetoed' && chain.code === 'case_promise_without_case'");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 1800);
    expect(janela).toMatch(/openedCaseThisTurn = true;\s*\n\s*moverParaHandoffBestEffort\(/);
  });

  it("a tool open_human_case (caso deliberado do modelo) também chama moverParaHandoffBestEffort", () => {
    const i = FONTE_INBOUND.indexOf("rawTools.open_human_case = tool({");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 1500);
    expect(janela).toMatch(/openedCaseThisTurn = true;\s*\n\s*moverParaHandoffBestEffort\(/);
  });

  it("moverParaHandoffBestEffort é best-effort — nunca derruba o turno (.catch, não throw)", () => {
    const i = FONTE_INBOUND.indexOf("const moverParaHandoffBestEffort = ");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 500);
    expect(janela).toContain(".catch(");
  });
});

describe("fiação — lead urgente represado pelo cap de warm-up gera alerta crítico", () => {
  it("o bloco de reagendamento por cap checa detectUrgencySignal e abre agent_inbox_items kind='handoff'", () => {
    const i = FONTE_INBOUND.indexOf("pacingCapVeto !== null && outcomes.length === 0");
    expect(i).toBeGreaterThan(-1);
    const janela = FONTE_INBOUND.slice(i, i + 2000);
    // A fonte do sinal mudou de "a última inbound do histórico" para "todo inbound
    // ainda não respondido", porque o drain COALESCE rajada: um relato de risco
    // que chega na 2ª mensagem entra de carona no job da 1ª e, lido só pela
    // mensagem do job, não existiria. O que esta guarda protege é o mesmo — o
    // bloco do cap CHECA urgência antes de adiar — e agora protege mais.
    expect(janela).toContain("inboundsPendentes.some((texto) => detectUrgencySignal(texto))");
    expect(janela).toMatch(/kind:\s*'handoff'/);
    expect(janela).toMatch(/severity:\s*'critical'/);
  });
});

describe("fiação — resposta manual pelo WhatsApp silencia o bot temporariamente", () => {
  // O helper mudou de casa e de nome (era `silenciarBotPorRetomadaHumana`, local
  // deste arquivo; virou `pausarIaPorAtendimentoManual`, compartilhado com os
  // outros canais). O que esta guarda protege é o mesmo de sempre: o caminho da
  // mensagem vinda do celular do operador CALA o bot, e não só grava histórico.
  it("handleOutboundFromUserPhone chama pausarIaPorAtendimentoManual depois de registrar a mensagem", () => {
    const i = FONTE_INGEST.indexOf("async function handleOutboundFromUserPhone(");
    expect(i).toBeGreaterThan(-1);
    const j = FONTE_INGEST.indexOf("async function handleAck(", i);
    expect(j).toBeGreaterThan(i);
    const corpo = FONTE_INGEST.slice(i, j);
    expect(corpo).toContain('sent_via: "external_device"');
    expect(corpo).toContain("pausarIaPorAtendimentoManual(admin, {");
    expect(corpo).toMatch(/pausarIaPorAtendimentoManual\(admin, \{[\s\S]{0,200}organizationId: session\.organization_id/);
  });

  /**
   * A ORDEM, e não só a presença. O eco do próprio envio do CRM chega por este
   * mesmo caminho com `fromMe: true`, e na janela em que a linha do envio ainda
   * não tem `external_id` o dedup NÃO o pega (issue #519). Sem a guarda, a IA se
   * cala porque ela mesma falou.
   *
   * `eco-do-envio-nao-silencia-o-bot.test.ts` mede o COMPORTAMENTO; esta guarda
   * mede a FIAÇÃO — que a pausa está DENTRO da guarda de eco, e não ao lado
   * dela. Um refactor que desaninhasse as duas manteria os dois símbolos no
   * arquivo e passaria pela asserção de presença acima.
   *
   * Atualizada em 2026-09-24 (C-075): o `if` deixou de ser inline e passou a
   * guardar os três desfechos (`#off` durável / `#on` devolve / mensagem normal
   * pausa durável). O que a guarda protege continua o mesmo: TODA ação sobre o
   * automático somente acontece se `!ehEco`.
   */
  it("a ação sobre o automático acontece DENTRO da guarda de eco, nunca ao lado dela", () => {
    const i = FONTE_INGEST.indexOf("async function handleOutboundFromUserPhone(");
    const j = FONTE_INGEST.indexOf("async function handleAck(", i);
    const corpo = FONTE_INGEST.slice(i, j);
    expect(corpo).toMatch(
      /const ehEco = await ehEcoDeEnvioNosso\([^)]*\);[\s\S]{0,80}?if \(!ehEco\) \{/,
    );
    expect(corpo).toMatch(/if \(!ehEco\) \{[\s\S]{0,700}?pausarIaDuravelmente\(/);
    expect(corpo).toMatch(/if \(!ehEco\) \{[\s\S]{0,700}?devolverAtendimentoAoAgente\(/);
    // A pausa da mensagem comum também, e o interruptor do agente (que decide
    // se a pausa é durável) é lido DENTRO da guarda — nunca para o eco.
    expect(corpo).toMatch(/if \(!ehEco\) \{[\s\S]{0,2000}?pausarIaPorAtendimentoManual\(/);
    expect(corpo).toMatch(/if \(!ehEco\) \{[\s\S]{0,400}?agenteAceitaComandoDeCelular\(/);
  });
});
