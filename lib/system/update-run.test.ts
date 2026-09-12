import { describe, expect, it } from "vitest";

import {
  canTransition,
  isRunStale,
  rollbackFoiSuperado,
  sucessoJaInstalado,
  RUN_STALE_AFTER_MS,
} from "./update-run";

describe("canTransition", () => {
  it("aceita o desfecho reportado pelo agente", () => {
    expect(canTransition("dispatched", "success")).toBe(true);
    expect(canTransition("dispatched", "failed")).toBe(true);
    expect(canTransition("dispatched", "failed_rolled_back")).toBe(true);
  });

  it("recusa mexer num run que já terminou", () => {
    expect(canTransition("success", "failed")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
    expect(canTransition("failed_rolled_back", "success")).toBe(false);
  });

  it("recusa voltar para dispatched", () => {
    expect(canTransition("success", "dispatched")).toBe(false);
    expect(canTransition("dispatched", "dispatched")).toBe(false);
  });
});

describe("isRunStale", () => {
  const dispatched = "2026-07-28T12:00:00.000Z";

  it("não é velho antes do teto", () => {
    const now = new Date(Date.parse(dispatched) + RUN_STALE_AFTER_MS - 1000);
    expect(isRunStale(dispatched, now)).toBe(false);
  });

  it("é velho depois do teto", () => {
    const now = new Date(Date.parse(dispatched) + RUN_STALE_AFTER_MS + 1000);
    expect(isRunStale(dispatched, now)).toBe(true);
  });

  it("data inválida conta como velho — o que não dá para afirmar, não se afirma", () => {
    expect(isRunStale("isso não é data", new Date())).toBe(true);
  });
});

describe("rollbackFoiSuperado", () => {
  const fimDoRun = "2026-08-28T01:51:52.000Z";
  const RUN = { from_version: "1.0.0", to_version: "1.1.0" };

  it("outro caminho subiu OUTRA versão depois do run: o run não descreve mais o presente", () => {
    // O caso medido em produção: oito dias e vários deploys depois, o rodapé
    // seguia anunciando a versão de 28 de agosto.
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun, "1.2.0", RUN)).toBe(true);
  });

  it("logo depois do rollback, o host reporta a versão que QUEBROU — e o run vence", () => {
    // O agente roda `git describe` depois do checkout, então ele reporta a
    // `to_version`: a que instalou e que o contêiner recusou. Essa batida chega
    // segundos DEPOIS do run, e comparar só as datas fazia a tela voltar a
    // acreditar nela. Cenário exercido inteiro por tests/e2e/system-update.spec.ts.
    expect(rollbackFoiSuperado("2026-08-28T01:51:58.000Z", fimDoRun, "1.1.0", RUN)).toBe(false);
  });

  it("host reportando a versão RESTAURADA também não supera: é o run concordando consigo", () => {
    expect(rollbackFoiSuperado("2026-08-28T01:52:30.000Z", fimDoRun, "1.0.0", RUN)).toBe(false);
  });

  it("agente gravou antes do run: o rollback ainda é a notícia mais nova", () => {
    expect(rollbackFoiSuperado("2026-08-28T01:40:00.000Z", fimDoRun, "1.2.0", RUN)).toBe(false);
  });

  it("sem saber a versão reportada, fica valendo o run — o degrau conservador", () => {
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun, "", RUN)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun, null, RUN)).toBe(false);
  });

  it("run sem as versões: qualquer coisa que o host reporte supera", () => {
    // Run de um agente antigo. Aqui não há o que comparar, e a data volta a ser
    // o único sinal — que é melhor que nomear para sempre uma versão que
    // nenhuma linha do banco confirma.
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun, "1.2.0", {})).toBe(true);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun, "1.2.0", null)).toBe(true);
  });

  it("sem uma das datas, não afirma nada — e não afirmar mantém o run valendo", () => {
    expect(rollbackFoiSuperado(null, fimDoRun, "1.2.0", RUN)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", null, "1.2.0", RUN)).toBe(false);
    expect(rollbackFoiSuperado(undefined, undefined)).toBe(false);
  });

  it("data ilegível não vira comparação: NaN compara falso e mentiria por acidente", () => {
    expect(rollbackFoiSuperado("isso não é data", fimDoRun, "1.2.0", RUN)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", "isso não é data", "1.2.0", RUN)).toBe(false);
  });
});


/**
 * A JANELA EM QUE A ATUALIZAÇÃO DEU CERTO E A TELA AINDA NÃO SABIA.
 *
 * `run_result` com `success` fecha o run e não escreve em
 * `system_version.current_version` — quem escreve é o heartbeat do host, de 5 em
 * 5 minutos. Nessa janela `update_available` (`latest !== current`) continuava
 * verdadeiro, e a tela voltava do reinício oferecendo "Atualizar agora" para a
 * versão que acabou de ser instalada.
 *
 * O desempate é o mesmo de `rollbackFoiSuperado`, na direção contrária: lá o
 * host mais novo vence o run; aqui o run vence enquanto o host não falou.
 */
describe("sucessoJaInstalado", () => {
  const FIM = "2026-09-11T14:00:00.000Z";
  const RUN = { status: "success", to_version: "1.1.0" };

  it("run bem-sucedido e host ainda calado: o run manda", () => {
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", FIM, RUN)).toBe(true);
  });

  it("host bateu DEPOIS do fim: quem manda volta a ser o host", () => {
    // É o fim de validade desta função — e ele chega sozinho, em minutos.
    expect(sucessoJaInstalado("2026-09-11T14:05:00.000Z", FIM, RUN)).toBe(false);
  });

  it("empate de segundo conta como host calado — o degrau que não reoferece", () => {
    // As duas escritas vêm de relógios diferentes. Errar aqui para o lado de
    // "já atualizou" custa alguns minutos de rótulo otimista; errar para o
    // outro lado devolve o botão que manda instalar de novo o que já está lá.
    expect(sucessoJaInstalado(FIM, FIM, RUN)).toBe(true);
  });

  it("host nunca reportou nada: o run é a única notícia que existe", () => {
    expect(sucessoJaInstalado(null, FIM, RUN)).toBe(true);
    expect(sucessoJaInstalado(undefined, FIM, RUN)).toBe(true);
    expect(sucessoJaInstalado("isso não é data", FIM, RUN)).toBe(true);
  });

  it("só vale para SUCESSO — falha e rollback têm dono próprio nesta tela", () => {
    for (const status of ["dispatched", "failed", "failed_rolled_back"]) {
      expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", FIM, { status, to_version: "1.1.0" })).toBe(
        false,
      );
    }
  });

  it("sem `to_version` não há o que afirmar", () => {
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", FIM, { status: "success" })).toBe(false);
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", FIM, { status: "success", to_version: "" })).toBe(
      false,
    );
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", FIM, null)).toBe(false);
  });

  it("sem `finished_at` (run de agente antigo) não afirma nada", () => {
    // Sem a data não dá para saber se o host já falou depois — e o degrau
    // conservador é o comportamento de antes desta função existir.
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", null, RUN)).toBe(false);
    expect(sucessoJaInstalado("2026-09-11T13:55:00.000Z", "isso não é data", RUN)).toBe(false);
  });
});
