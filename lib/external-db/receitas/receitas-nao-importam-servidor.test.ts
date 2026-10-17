/**
 * CERCA: receita é código que o NAVEGADOR carrega (a tela de Receitas prontas é
 * Client Component e importa o registro). Nenhum arquivo de produção de
 * `lib/external-db/receitas/` pode, direta ou textualmente, importar o que leva
 * a `pg`/`mysql2` (conexão, leitura, dialeto): o `next build` quebra com
 * "Can't resolve 'dns'/'fs'/'net'/'tls'". Erro de receita é `Error` com prefixo
 * na mensagem — quem decide é a ferramenta/rota, pelo prefixo.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PASTA = __dirname;
const PROIBIDOS = [/from\s+["']\.\.\/leitura["']/, /from\s+["']\.\.\/conexao["']/, /from\s+["']\.\.\/dialeto["']/, /from\s+["']\.\.\/dialetos/, /from\s+["']pg["']/, /from\s+["']mysql2/, /from\s+["']@\/lib\/external-db\/(leitura|conexao|dialeto|dialetos|acesso)/];

const ARQUIVOS = readdirSync(PASTA).filter((f) => f.endsWith(".ts") && !/\.(test|unit\.test)\.ts$/.test(f));

describe("receitas não importam código de servidor", () => {
  it("há arquivos para vigiar", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(5);
  });
  it.each(ARQUIVOS)("%s", (arquivo) => {
    const fonte = readFileSync(path.join(PASTA, arquivo), "utf8");
    for (const re of PROIBIDOS) expect(fonte, `${arquivo} importa ${re}`).not.toMatch(re);
  });
});
