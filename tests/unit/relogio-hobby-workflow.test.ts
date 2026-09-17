/**
 * Este relógio some do radar fácil: arquivo só numa branch de trabalho,
 * schedule que só roda na default, variável desligada. Este teste ancora o
 * contrato mínimo no fonte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAMINHO_DO_TICK, urlDoTickDoRelogio } from "@/lib/relogio/tarefas";

describe("workflow relogio (Hobby)", () => {
  const yml = readFileSync(join(process.cwd(), ".github/workflows/relogio.yml"), "utf8");

  it("bate o tick HTTP e não o cron diário da Vercel", () => {
    expect(yml).toContain(CAMINHO_DO_TICK);
    expect(yml).toMatch(/schedule:/);
    expect(yml).toMatch(/RELOGIO_LIGADO/);
    expect(yml).toMatch(/RELOGIO_APP_URL/);
    expect(yml).toMatch(/RELOGIO_SECRET/);
  });

  it("falha em HTTP não-2xx (senão Actions fica verde com follow-up morto)", () => {
    expect(yml).toMatch(/2\?\?/);
    expect(yml).toMatch(/exit 1/);
  });
});

describe("urlDoTickDoRelogio", () => {
  it("monta a URL que o cron-job.org cola", () => {
    expect(urlDoTickDoRelogio("https://crm.exemplo.com/")).toBe(
      `https://crm.exemplo.com${CAMINHO_DO_TICK}`,
    );
  });
});
