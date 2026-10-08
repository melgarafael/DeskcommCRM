import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * BOARD ESCONDE PESSOAL, LINHA FICA (spec 21, etapa 8 — critério 4, decisão 2).
 *
 * Negócio aberto de contato pessoal não é listado no board; a linha continua
 * no banco e volta ao desmarcar. Mensagem nova de marcado não abre negócio
 * (isso é a etapa 6, coberta em `contato-pessoal-entrada.test.ts`).
 *
 * ─── SABOTAGEM (prova no CI) ───────────────────────────────────────────────
 * - Trocar o filtro por `delete`: a volta vem vazia (critério 4 acusa — aqui,
 *   o caso "nenhum delete" cai porque o fonte passa a conter `delete`/`remove`
 *   no caminho dos leads).
 * - Tirar o filtro da leitura: o caso "board filtra" cai.
 * Linha para reverter: `app/api/v1/pipelines/[id]/board/route.ts`.
 */

const RAIZ = process.cwd();
const fonte = (...partes: string[]) => fs.readFileSync(path.join(RAIZ, ...partes), "utf8");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const QUADRO = semComentarios(
  fonte("app", "api", "v1", "pipelines", "[id]", "board", "route.ts"),
);

describe("board do funil esconde pessoal sem apagar (critério 4)", () => {
  it("filtra os leads de contatos pessoais pela mesma primitiva da lista", () => {
    expect(QUADRO).toMatch(/idsDeContatosPessoais/);
    expect(QUADRO).toMatch(/leadsVisiveis/);
  });

  it("o filtro acontece na leitura, depois de ler e sem paginar para trás", () => {
    // O board não pagina: filtrar em memória sobre a lista lida não perde nada.
    expect(QUADRO).toMatch(/\.filter\(/);
  });

  it("nenhum delete/remove no caminho dos leads (esconder não é apagar)", () => {
    expect(QUADRO).not.toMatch(/\.delete\(\)/);
    expect(QUADRO).not.toMatch(/\.remove\(/);
  });
});
