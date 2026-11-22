import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { razaoDeContraste } from "@/lib/branding/contraste";
import { corDoParticipante, PALETA_DE_PARTICIPANTES } from "@/lib/messaging/cor-do-participante";

/** O fundo do balão recebido (`bg-muted` → `--color-surface-elevated`) lido do tema, não copiado. */
function fundoDoBalao(seletor: string): string {
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const inicio = css.indexOf(`\n${seletor} {`);
  expect(inicio, `bloco ${seletor} em globals.css`).toBeGreaterThanOrEqual(0);
  const bloco = css.slice(inicio, css.indexOf("\n}", inicio + 1));
  const valor = /--color-surface-elevated:\s*(#[0-9a-f]{6})\s*;/i.exec(bloco)?.[1];
  expect(valor, `--color-surface-elevated em ${seletor}`).toBeDefined();
  return valor ?? "";
}

describe("cor do participante no grupo", () => {
  it("a mesma pessoa tem sempre a mesma cor", () => {
    const a = { lid: "123456789", phone: "+5511999990000", name: "Ana" };
    expect(corDoParticipante(a)).toBe(corDoParticipante({ ...a, name: "Ana Paula" }));
    expect(PALETA_DE_PARTICIPANTES).toContain(corDoParticipante(a));
  });

  it("a identidade é o lid; sem ele, o telefone; sem ele, o nome", () => {
    expect(corDoParticipante({ lid: null, phone: "+5511988887777", name: "X" })).toBe(
      corDoParticipante({ lid: null, phone: "+5511988887777", name: "Y" }),
    );
    expect(corDoParticipante({ lid: null, phone: null, name: "Bia" })).toBe(
      corDoParticipante({ lid: null, phone: null, name: "Bia" }),
    );
    expect(corDoParticipante({ lid: null, phone: null, name: null })).toBeNull();
  });

  it("pessoas diferentes se espalham pela paleta", () => {
    const cores = new Set(
      Array.from({ length: 40 }, (_, i) =>
        corDoParticipante({ lid: String(100000 + i * 7919), phone: null, name: null }),
      ),
    );
    expect(cores.size).toBeGreaterThanOrEqual(8);
  });

  it.each([
    ["claro", ":root"],
    ["escuro", '[data-theme="dark"]'],
  ] as const)("todo tom no tema %s tem contraste de texto (≥ 4,5:1) contra o balão", (tema, seletor) => {
    const fundo = fundoDoBalao(seletor);
    const reprovados = PALETA_DE_PARTICIPANTES.map((c) => [c[tema], razaoDeContraste(c[tema], fundo)] as const).filter(
      ([, razao]) => razao < 4.5,
    );
    expect(reprovados, `fundo ${fundo}`).toEqual([]);
  });
});
