/**
 * #3868: desligar um módulo PARA UMA EMPRESA em /admin/sistema promete "esconder
 * a porta do módulo no menu desta empresa". As portas moram no menu lateral e nos
 * hubs (Configurações, CRM, IA, Análise), e cada um decide pela lista de
 * `modulosLigados`. Sem o id da empresa, a lista é a da INSTALAÇÃO — e a porta
 * fica aberta para a empresa que o desligou (medido na prova de tela do #4065:
 * o hub de Configurações seguia mostrando Propostas).
 *
 * A regra: toda chamada de `modulosLigados(` sob app/app passa um segundo
 * argumento (a empresa ativa).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const arquivos = execFileSync("git", ["grep", "-l", "modulosLigados(", "--", "app/app"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));

describe("as portas dos módulos seguem a empresa ativa", () => {
  it("há chamadas para conferir (controle positivo)", () => {
    expect(arquivos.length).toBeGreaterThan(3);
  });

  it.each(arquivos)("%s passa a empresa a modulosLigados", (arquivo) => {
    const fonte = readFileSync(arquivo, "utf8");
    const chamadas = [...fonte.matchAll(/modulosLigados\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map((m) => m[1] ?? "");
    for (const args of chamadas) {
      expect(args.includes(","), `${arquivo}: modulosLigados(${args}) sem a empresa`).toBe(true);
    }
  });
});
