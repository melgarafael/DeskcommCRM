/**
 * CERCA: rota que o módulo alcança e que traz o CONTATO na resposta (Spec 33, F3; ADR-0005 D4).
 *
 * O consentimento por área vale para o dado que vem dentro da resposta. Uma rota de outra área que
 * embute contato (nome, telefone, e-mail) precisa de UMA destas três saídas:
 *   1. chamar `redigirContatoParaModulo` (o módulo sem `contatos` recebe só o id);
 *   2. estar em `LEITURAS_COM_CONTATO_EMBUTIDO` (a porta exige também `contatos` em leitura);
 *   3. estar na lista `JUSTIFICADAS` abaixo, com o motivo escrito.
 * Rota nova que embute contato e não faz nenhuma das três reprova aqui.
 *
 * O que a cerca olha: o `route.ts` e o `_handler.ts` da MESMA pasta, sem comentários. Handler em pasta
 * pai (ex.: `conversations/_handler.ts`, usado por `conversations/[id]/route.ts`) fica fora do alcance:
 * é por isso que as rotas de conversa chamam o redator na própria rota, e esta cerca confere isso.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { areaDaPorta, leituraExigeAreaContatos } from "@/lib/auth/portas-de-token/areas";

import { metodosExportados, modeloDaRota, semComentarios } from "./helpers/contrato-do-modulo";

const RAIZ = process.cwd();
const API = join(RAIZ, "app/api/v1");

/** Modelo da rota → por que ela não precisa do redator nem da trava. Motivo sempre escrito. */
const JUSTIFICADAS: Record<string, string> = {
  "/api/v1/leads/import":
    "POST: a resposta é o resumo da importação (contagens e erro por linha), sem dado de contato lido do banco.",
  "/api/v1/conversations/[id]/participants":
    "lê só o indicador `is_personal` do contato para decidir a regra; a resposta não devolve o contato.",
};

const TRAZ_CONTATO = /contacts?\s*:\s*\w*\s*\(|contacts!?\w*\s*\(|from\(\s*["']contacts["']\s*\)|contact_(?:name|phone|email)\b/;

function rotas(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...rotas(caminho));
    else if (nome === "route.ts") achados.push(caminho);
  }
  return achados;
}

function textoDaRota(arquivo: string): { rota: string; completo: string } {
  const rota = semComentarios(readFileSync(arquivo, "utf8"));
  const handler = arquivo.replace(/route\.ts$/, "_handler.ts");
  const completo = existsSync(handler) ? `${rota}\n${semComentarios(readFileSync(handler, "utf8"))}` : rota;
  return { rota, completo };
}

describe("rota que o módulo alcança e traz contato na resposta", () => {
  const todas = rotas(API);

  it("a varredura achou as rotas (a cerca não passa varrendo nada)", () => {
    expect(todas.length).toBeGreaterThan(200);
  });

  it("toda rota assim redige, exige a área `contatos` ou está justificada", () => {
    const sem: string[] = [];
    for (const arquivo of todas) {
      const modelo = modeloDaRota(RAIZ, arquivo);
      const { rota, completo } = textoDaRota(arquivo);
      if (!TRAZ_CONTATO.test(completo)) continue;
      for (const metodo of metodosExportados(rota)) {
        const porta = areaDaPorta(modelo, metodo);
        if (!porta || porta.area === "contatos") continue; // sem área: módulo recusado; contatos: a área é dele
        if (rota.includes("redigirContatoParaModulo")) continue;
        if (leituraExigeAreaContatos(modelo, metodo)) continue;
        if (JUSTIFICADAS[modelo]) continue;
        sem.push(`${metodo} ${modelo} (área ${porta.area})`);
      }
    }
    expect(
      sem,
      "Rota que o módulo alcança e traz contato, sem redigir, sem exigir `contatos` e sem justificativa:\n" +
        sem.join("\n"),
    ).toEqual([]);
  });

  it("toda justificativa aponta para uma rota que existe e tem motivo escrito", () => {
    const modelos = new Set(todas.map((a) => modeloDaRota(RAIZ, a)));
    for (const [modelo, motivo] of Object.entries(JUSTIFICADAS)) {
      expect(modelos.has(modelo), `justificativa de rota que não existe: ${modelo}`).toBe(true);
      expect(motivo.length).toBeGreaterThan(20);
    }
  });

  it("as rotas de conversa e o quadro de negócios chamam o redator", () => {
    for (const rel of [
      "conversations/route.ts",
      "conversations/[id]/route.ts",
      "pipelines/[id]/board/route.ts",
    ]) {
      const texto = semComentarios(readFileSync(join(API, rel), "utf8"));
      expect(texto, rel).toContain("redigirContatoParaModulo");
    }
  });
});
