import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O TETO DE MEMÓRIA SE AJUSTA PELO `.env`, E O PADRÃO NÃO MUDA.
 *
 * Os tetos do `docker-compose.prod.yml` foram dimensionados sobre picos medidos
 * numa VPS de 3,8 GB. Numa máquina maior, o operador precisa subi-los — e o
 * compose não é lugar para isso: ele é arquivo do clone, e o `git checkout` do
 * update.sh recusa a versão nova quando o arquivo editado à mão também mudou
 * nela ("parece haver mudanças locais que divergem"). Por isso o teto lê
 * `APP_MEM_LIMIT`, `WORKER_MEM_LIMIT` e `WAHA_MEM_LIMIT`, com o valor de sempre
 * como padrão.
 *
 * Duas coisas são vigiadas aqui:
 * 1. o PADRÃO segue o valor medido — quem não escreve nada no `.env` fica
 *    exatamente como antes (a doutrina de packaging proíbe atualização que
 *    peça edição de `.env`);
 * 2. cada variável está DOCUMENTADA no modelo de `.env` que o kit distribui —
 *    knob sem superfície é knob que ninguém acha.
 */
const RAIZ = path.resolve(__dirname, "..", "..");
const COMPOSE = fs.readFileSync(path.join(RAIZ, "docker-compose.prod.yml"), "utf8");
const MODELO_ENV = fs.readFileSync(path.join(RAIZ, ".env.hostgator.example"), "utf8");

/** Bloco de um serviço de topo em `services:`, sem as linhas de comentário. */
function blocoDoServico(yaml: string, nome: string): string {
  const linhas = yaml.split("\n");
  const inicio = linhas.findIndex((l) => l === `  ${nome}:`);
  if (inicio < 0) return "";
  const corpo: string[] = [];
  for (const linha of linhas.slice(inicio + 1)) {
    if (/^ {0,2}\S/.test(linha)) break;
    if (!/^\s*#/.test(linha)) corpo.push(linha);
  }
  return corpo.join("\n");
}

const TETOS = [
  { servico: "app", variavel: "APP_MEM_LIMIT", padrao: "768m" },
  { servico: "worker", variavel: "WORKER_MEM_LIMIT", padrao: "512m" },
  { servico: "waha", variavel: "WAHA_MEM_LIMIT", padrao: "1280m" },
] as const;

describe("teto de memória configurável pelo .env", () => {
  it("o leitor enxerga os três serviços (guarda do instrumento)", () => {
    for (const { servico } of TETOS) {
      expect(blocoDoServico(COMPOSE, servico), servico).toMatch(/\bimage:/);
    }
  });

  for (const { servico, variavel, padrao } of TETOS) {
    it(`${servico}: mem_limit lê ${variavel} e cai em ${padrao}`, () => {
      const tetos = blocoDoServico(COMPOSE, servico).match(/^\s*mem_limit:.*$/gm) ?? [];
      expect(tetos.map((l) => l.trim())).toEqual([`mem_limit: \${${variavel}:-${padrao}}`]);
    });

    it(`${variavel} está documentada no modelo de .env`, () => {
      expect(MODELO_ENV).toMatch(new RegExp(`^# ${variavel}=\\d+m$`, "m"));
    });
  }
});
