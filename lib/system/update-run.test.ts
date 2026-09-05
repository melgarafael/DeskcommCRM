import { describe, expect, it } from "vitest";

import { canTransition, isRunStale, rollbackFoiSuperado, RUN_STALE_AFTER_MS } from "./update-run";

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

  it("agente gravou depois do run: o run não descreve mais o presente", () => {
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", fimDoRun)).toBe(true);
  });

  it("agente gravou antes do run: o rollback ainda é a notícia mais nova", () => {
    expect(rollbackFoiSuperado("2026-08-28T01:40:00.000Z", fimDoRun)).toBe(false);
  });

  it("sem uma das datas, não afirma nada — e não afirmar mantém o run valendo", () => {
    expect(rollbackFoiSuperado(null, fimDoRun)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", null)).toBe(false);
    expect(rollbackFoiSuperado(undefined, undefined)).toBe(false);
  });

  it("data ilegível não vira comparação: NaN compara falso e mentiria por acidente", () => {
    expect(rollbackFoiSuperado("isso não é data", fimDoRun)).toBe(false);
    expect(rollbackFoiSuperado("2026-09-05T15:35:02.000Z", "isso não é data")).toBe(false);
  });
});
