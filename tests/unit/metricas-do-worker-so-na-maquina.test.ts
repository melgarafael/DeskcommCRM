import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O /metrics do worker não tem autenticação e responde números de TODAS as
 * empresas da instalação (filas, sessões, custo). Em produção ele nem é
 * publicado — `portas-do-compose.test.ts` vigia isso. Os composes de
 * desenvolvimento e de instalação local publicam a porta de propósito, para
 * quem está na máquina olhar; o defeito era publicar em 0.0.0.0, que entrega
 * os mesmos números a qualquer um na mesma rede.
 *
 * Por que não trocar o bind do processo para 127.0.0.1: o mapeamento de porta
 * do Docker entrega o tráfego na interface do container, não no loopback dele —
 * o gate de publicação (`publish-image.yml`, `-p 127.0.0.1:3971:3971`) deixaria
 * de enxergar o /healthz. A restrição certa mora no lado do host.
 */
const COMPOSES = ["docker-compose.yml", "docker-compose.local.yml"] as const;

function linhasDePortaDoWorker(yaml: string): string[] {
  const inicio = yaml.search(/^ {2}worker:\s*$/m);
  if (inicio < 0) return [];
  const resto = yaml.slice(inicio + 1);
  const fim = resto.search(/^ {2}[a-z0-9_-]+:\s*$/m);
  const bloco = fim < 0 ? resto : resto.slice(0, fim);
  return bloco
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => /^-\s*"?[\d.:]+"?$/.test(l) && l.includes("8787"));
}

describe("métricas do worker ficam na máquina de quem roda", () => {
  for (const arquivo of COMPOSES) {
    it(`${arquivo}: a porta 8787 só é publicada em 127.0.0.1`, () => {
      const yaml = fs.readFileSync(path.join(process.cwd(), arquivo), "utf8");
      const linhas = linhasDePortaDoWorker(yaml);
      // Controle positivo: se o parser não achar a linha, o teste não pode
      // passar por "não havia nada para reprovar".
      expect(linhas.length).toBeGreaterThan(0);
      for (const linha of linhas) {
        expect(linha).toMatch(/^-\s*"?127\.0\.0\.1:8787:8787"?$/);
      }
    });
  }
});
