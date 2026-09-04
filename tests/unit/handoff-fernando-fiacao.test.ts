import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FIAÇÃO — mesmo padrão de `gate-agenda-stall.test.ts`/`gate-vazamento-interno.test.ts`:
 * prova que os pontos de conserto do handoff "fantasma" pro Fernando (achado em
 * produção, tenant YADEA — o bot dizia "vou verificar com o Fernando" repetidas
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
    expect(janela).toContain("detectUrgencySignal(inboundSignal)");
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
   * mede a FIAÇÃO — que a pausa está DENTRO do `if`, e não ao lado dele. Um
   * refactor que desaninhasse as duas manteria os dois símbolos no arquivo e
   * passaria pela asserção de presença acima.
   */
  it("a pausa acontece DENTRO da guarda de eco, nunca ao lado dela", () => {
    const i = FONTE_INGEST.indexOf("async function handleOutboundFromUserPhone(");
    const j = FONTE_INGEST.indexOf("async function handleAck(", i);
    const corpo = FONTE_INGEST.slice(i, j);
    expect(corpo).toMatch(
      /if \(!\(await ehEcoDeEnvioNosso\([^)]*\)\)\) \{[\s\S]{0,300}?pausarIaPorAtendimentoManual\(/,
    );
  });
});
