/**
 * O ID DE UM TOKEN (ATOR `module`, `api_token`, `ai_agent`) NUNCA VAI PARA COLUNA DE PESSOA.
 *
 * `actor.id` de quem não é pessoa é o id de um token ou de um run. As colunas `…_by_user_id`,
 * `owner_user_id` e `actor_user_id` têm FK para `auth.users`: o INSERT morre, ou pior, a atribuição some
 * em silêncio. O padrão do repo é `actor.type === "user" ? actor.id : null`, e ele só vale quando o teste
 * é contra `"user"`. Um `actor.type !== "api_token"` deixaria passar o ator `module` (spec 33, F2).
 *
 * A varredura lê `app/api/v1` e `lib/mcp/tools`:
 *   1. toda atribuição de `….actor.id` a coluna de pessoa precisa de `type === "user"` na mesma linha ou
 *      nas três anteriores (o `if (actor.type === "user") {` que abre o bloco);
 *   2. nenhum guarda de pessoa pode ser escrito por exclusão (`actor.type !== "api_token" | "module"
 *      | "webhook_source"`).
 *
 * Exceções: nenhuma hoje. A lista fica aqui, com o motivo de cada uma, se algum dia houver.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const RAIZES = ["app/api/v1", "lib/mcp/tools"] as const;

/** Colunas/campos que acabam em coluna com FK para `auth.users`. `userId`/`user_id` de consulta ficam de fora. */
const COLUNA_DE_PESSOA =
  /(?:\b\w*_by_user_id|\bowner_user_id|\bactor_user_id|\bactorUserId|\bassigned_to_user_id)["']?\s*:\s*[^,;\n]*\bactor\.id\b/;
const GUARDA_DE_PESSOA = /type\s*===\s*"user"/;
// `ai_agent` fica de fora de propósito: `!== "ai_agent"` em `agendamentos/_handler.ts` guarda a RESERVA da
// IA (booking), não decide quem é pessoa.
const GUARDA_POR_EXCLUSAO = /actor\.type\s*!==?\s*"(?:api_token|module|webhook_source)"/;

const EXCECOES: ReadonlyMap<string, string> = new Map();

function atribuicoesSemGuarda(texto: string): { linha: number; trecho: string }[] {
  const linhas = texto.split("\n");
  const achados: { linha: number; trecho: string }[] = [];
  linhas.forEach((trecho, i) => {
    if (!COLUNA_DE_PESSOA.test(trecho)) return;
    const janela = linhas.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (!GUARDA_DE_PESSOA.test(janela)) achados.push({ linha: i + 1, trecho: trecho.trim() });
  });
  return achados;
}

describe("ator que não é pessoa não vira coluna de pessoa", () => {
  const arquivos = arquivosDeCodigo(RAIZES);

  it("a varredura enxerga os arquivos (controle positivo)", () => {
    expect(arquivos.length).toBeGreaterThan(50);
    const comPadrao = arquivos.filter((f) => COLUNA_DE_PESSOA.test(readFileSync(f, "utf8")));
    // Os `actorAuditPayload`/`actorAudit` dos handlers e das tools são o padrão que a regra protege.
    expect(comPadrao.length).toBeGreaterThanOrEqual(8);
  });

  it("o detector pega a atribuição sem guarda e deixa passar a guardada", () => {
    expect(atribuicoesSemGuarda("const x = { created_by_user_id: ctx.actor.id };")).toHaveLength(1);
    expect(
      atribuicoesSemGuarda('const x = { owner_user_id: actor.type !== "api_token" ? actor.id : null };'),
    ).toHaveLength(1);
    expect(
      atribuicoesSemGuarda('const x = { created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null };'),
    ).toHaveLength(0);
    expect(
      atribuicoesSemGuarda('if (actor.type === "user") {\n  return { actorUserId: actor.id };\n}'),
    ).toHaveLength(0);
  });

  it("toda atribuição de actor.id a coluna de pessoa tem o guarda `type === \"user\"`", () => {
    const violacoes: string[] = [];
    for (const arquivo of arquivos) {
      const rel = caminhoRelativo(arquivo);
      if (EXCECOES.has(rel)) continue;
      for (const a of atribuicoesSemGuarda(readFileSync(arquivo, "utf8"))) {
        violacoes.push(`${rel}:${a.linha}  ${a.trecho}`);
      }
    }
    expect(violacoes).toEqual([]);
  });

  it("nenhum guarda de pessoa é escrito por exclusão (deixaria `module` passar)", () => {
    const violacoes: string[] = [];
    for (const arquivo of arquivos) {
      const rel = caminhoRelativo(arquivo);
      readFileSync(arquivo, "utf8")
        .split("\n")
        .forEach((linha, i) => {
          if (GUARDA_POR_EXCLUSAO.test(linha) && /[?&|]|\bif\b/.test(linha)) {
            violacoes.push(`${rel}:${i + 1}  ${linha.trim()}`);
          }
        });
    }
    expect(violacoes).toEqual([]);
  });
});
