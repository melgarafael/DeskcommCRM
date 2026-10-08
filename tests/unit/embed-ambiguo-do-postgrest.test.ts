/**
 * EMBED DE POSTGREST PARA TABELA COM MAIS DE UMA FK PRECISA DE DICA.
 *
 * ─── O defeito que isto fecha, e por que nenhum teste de unidade o pegou ────
 *
 * `extension_installations` tem DUAS chaves estrangeiras para
 * `extension_artifacts` — `artifact_id` e `previous_artifact_id` (a segunda
 * chegou depois, por `add column`). Com duas, o PostgREST não consegue decidir
 * por qual embutir e recusa a consulta inteira (`PGRST201`, "more than one
 * relationship was found").
 *
 * As duas leituras da onda 1 escreviam o embed SEM dica
 * (`extension_artifacts!inner(manifest)`), e as duas falham fechado por projeto:
 * `paineisDaEntidade` devolve `[]` e `tabelaDoObjeto` devolve `null`. O produto
 * ficava assim: módulo instalado, tabela criada, ficha gravada — e a tela do
 * contato em branco, sem erro em lugar nenhum.
 *
 * Os quatro testes da rota estavam VERDES porque o cliente Supabase era dublê: o
 * mock aceita qualquer string de `select`, e a ambiguidade só existe no
 * PostgREST de verdade. É a mesma armadilha do mock que inventa a forma do dado,
 * um nível acima — aqui o dublê inventa a FORMA DO SCHEMA.
 *
 * ─── Por que uma varredura de código, e não um invariante de banco ─────────
 *
 * O `pnpm test:db` sobe Postgres puro, sem PostgREST: nada lá emite a consulta
 * que falha. Quem pega de verdade é o e2e (e pegou). Esta varredura é a catraca
 * baratae — ela lê o baseline para saber quantas FKs existem, então ela se
 * atualiza sozinha quando o schema mudar, e reprova o embed sem dica no código.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo } from "./helpers/varrer-codigo";

const RAIZ = join(__dirname, "..", "..");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

/** Quantas FKs de `<origem>` apontam para `<destino>`, lidas do baseline. */
function fksEntre(origem: string, destino: string): string[] {
  const inicio = BASELINE.indexOf(`create table if not exists public.${origem} (`);
  if (inicio < 0) return [];
  const corpo = BASELINE.slice(inicio, BASELINE.indexOf("\n);", inicio));
  const inline = [...corpo.matchAll(new RegExp(`(\\w+) uuid[^,]*references public\\.${destino}\\(`, "g"))];
  const alters = [
    ...BASELINE.matchAll(
      new RegExp(
        `alter table public\\.${origem}[\\s\\S]*?add column if not exists (\\w+) uuid references public\\.${destino}\\(`,
        "g",
      ),
    ),
  ];
  return [...inline, ...alters].map((m) => m[1]!);
}

/**
 * Um embed sem dica, nas DUAS formas que o PostgREST aceita:
 *
 *   - `extension_artifacts(manifest)`        — a forma NUA
 *   - `extension_artifacts!inner(manifest)`  — `!inner` é modificador de JOIN, não dica
 *
 * A primeira versão desta catraca só olhava a forma com `!`, e um cético mostrou que
 * a sabotagem passava verde: trocar `!artifact_id!inner(` por `(` deixava o embed
 * igualmente ambíguo e a cerca calada. Cerca que não pega a forma mais simples do
 * defeito é cerca que dá falsa segurança.
 *
 * A dica legítima é o nome da COLUNA (`!artifact_id`), e por isso o padrão exige que,
 * depois do `!`, venha algo que NÃO seja apenas um modificador de join.
 */
const SEM_DICA = /extension_artifacts(?:!(?:inner|left))?\s*\(/;

describe("embed de PostgREST para tabela com várias FKs", () => {
  const fks = fksEntre("extension_installations", "extension_artifacts");

  it("controle: o baseline tem MAIS DE UMA FK para o artefato (senão esta catraca é vácuo)", () => {
    expect(fks).toEqual(expect.arrayContaining(["artifact_id", "previous_artifact_id"]));
    expect(fks.length).toBeGreaterThan(1);
  });

  it("⭐ nenhum arquivo embute extension_artifacts sem dizer por qual FK", () => {
    const culpados: string[] = [];
    for (const arquivo of arquivosDeCodigo(["lib", "app", "components", "workers", "hooks"])) {
      const texto = readFileSync(arquivo, "utf8");
      if (!texto.includes("extension_artifacts")) continue;
      for (const [i, linha] of texto.split("\n").entries()) {
        if (SEM_DICA.test(linha)) {
          culpados.push(`${arquivo.replace(RAIZ + "/", "")}:${i + 1}`);
        }
      }
    }
    // A forma certa é a DICA DE COLUNA — `extension_artifacts!artifact_id(...)` —
    // e não o nome da constraint, que é gerado pelo Postgres e pode divergir num
    // clone que criou a tabela por outro caminho.
    expect(culpados).toEqual([]);
  });
});
