/**
 * A migration 0580 e o apêndice dela no `baseline.sql` — o item 3 do desenho
 * (#2147) na forma que o repo cobra: três artefatos que se espelham.
 *
 * O que se guarda aqui não é o comportamento da cifragem (isso é de
 * `cadastro-do-mcp-externo-e-o-platform-admin.test.ts`, que cifra e abre de
 * verdade) — é que a mudança de schema EXISTE no arquivo que o self-host aplica
 * e na migration versionada. Sem o apêndice, a tela funcionaria no banco de
 * quem desenvolve e a organização de quem instalou não teria onde gravar a
 * chave.
 *
 * Idempotência é parte do contrato: o `update.sh` re-aplica o baseline num
 * banco existente a cada release, e um `add column` sem `if not exists` quebraria
 * alto justamente na instalação de produção.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = resolve(process.cwd());
const MIGRACOES = join(RAIZ, "supabase", "migrations");
const PREFIXO_NUMERO = /_(\d{4,5})_[a-z0-9_]+\.sql$/;

function arquivoDa0580(): { nome: string; conteudo: string } | null {
  const nome = readdirSync(MIGRACOES).find(
    (arquivo) => arquivo.endsWith("_0580_chave_cifrada_do_mcp_externo.sql"),
  );
  if (!nome) return null;
  return { nome, conteudo: readFileSync(join(MIGRACOES, nome), "utf8") };
}

describe("a chave do servidor MCP externo sai do jsonb (#2147, item 3)", () => {
  it("existe a migration 0580 com o cabeçalho `-- manifest:`", () => {
    const arquivo = arquivoDa0580();
    expect(arquivo, "migration 0580 ausente em supabase/migrations/").not.toBeNull();
    expect(arquivo!.conteudo).toMatch(/^-- manifest: .+/m);
  });

  it("o NÚMERO é único — dois irmãos medindo o próximo livre no mesmo dia colidem", () => {
    const numeros = readdirSync(MIGRACOES)
      .map((nome) => PREFIXO_NUMERO.exec(nome)?.[1])
      .filter((numero): numero is string => Boolean(numero));
    const repetidos = numeros.filter((numero, i) => numeros.indexOf(numero) !== i);
    expect(repetidos, "número de migration repetido").toEqual([]);
    expect(numeros).toContain("0580");
  });

  it("cria as quatro colunas cifradas, de forma idempotente", () => {
    const conteudo = arquivoDa0580()!.conteudo;
    for (const coluna of [
      "mcp_externo_chave_encrypted",
      "mcp_externo_chave_iv",
      "mcp_externo_chave_tag",
      "mcp_externo_chave_last4",
    ]) {
      expect(conteudo, `coluna ${coluna} não declarada`).toContain(coluna);
    }
    expect(conteudo).toContain("add column if not exists");
    // Nenhuma função nova em `public`: se nascesse, a doutrina exigiria
    // `revoke execute ... from public, anon` junto (ver MANIFEST e a issue).
    expect(conteudo).not.toMatch(/create (or replace )?function/i);
  });

  it("a 0580 se descreve NUM LUGAR SÓ: o cabeçalho, não o MANIFEST.md", () => {
    // A cerca `manifest-x-migrations` do repo proíbe a mesma migration nos DOIS
    // lugares: o `-- manifest:` do .sql é a fonte desde a reunião dos dois
    // arquivos, e uma linha a mais no MANIFEST.md faria os dois divergirem um
    // dia em silêncio. Este teste troca o "está no MANIFEST" pelo "não está nos
    // dois" — é a mesma regra medida pelo outro lado.
    const man = readFileSync(join(MIGRACOES, "MANIFEST.md"), "utf8");
    expect(
      man,
      "a 0580 está no MANIFEST.md E no cabeçalho do .sql — uma fonte só",
    ).not.toContain("0580_chave_cifrada_do_mcp_externo");
  });

  it("o baseline.sql espelha o apêndice — é ele que o self-host aplica", () => {
    const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
    expect(baseline, "apêndice 0580 ausente do baseline.sql").toContain(
      "APÊNDICE 0580",
    );
    expect(baseline).toContain("add column if not exists mcp_externo_chave_encrypted bytea");
    expect(baseline).toContain("add column if not exists mcp_externo_chave_last4 text");
    // Idempotente nos DOIS sentidos do `if not exists`: o update.sh re-aplica.
    expect(baseline).toMatch(
      /alter table public\.organizations\n\s+add column if not exists mcp_externo_chave_encrypted bytea/,
    );
  });
});
