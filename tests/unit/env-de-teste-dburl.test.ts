/**
 * O RESOLVEDOR DE CREDENCIAIS DEVOLVE A TRAVESSIA INTEIRA.
 *
 * ## O defeito que fez este arquivo existir
 *
 * `scripts/lib/env-de-teste.ts` centralizou a leitura de credenciais dos seeds
 * — refactor certo, e pelo motivo certo: antes cada seed lia `.env.local` do
 * disco ignorando `process.env`, e a suíte E2E semeava em PRODUÇÃO mesmo com o
 * ambiente de teste injetado.
 *
 * Mas a travessia saiu incompleta: `CredenciaisSupabase` não declarava `dbUrl`
 * e nenhum dos dois ramos a devolvia, enquanto **13 seeds** já liam
 * `credenciais.dbUrl` para abrir `pg.Pool`.
 *
 * ## Por que nenhum gate pegou
 *
 * `tsconfig.json` tem `"exclude": ["node_modules", ".next", "dist", "scripts/**"]`
 * — os seeds não são typechecked, então ler propriedade que o tipo não declara
 * não custa nada ao compilador.
 *
 * E o sintoma escolhia o ambiente, o que é o pior tipo de defeito para achar:
 *
 *   local → normalmente cai no ramo do ARQUIVO, ou o shell já tem a variável → passa
 *   CI    → o workflow EXPORTA as credenciais, o ramo "ambiente" vence → `undefined`
 *
 * Com `connectionString: undefined`, o `pg` cai no default do libpq e tenta
 * `127.0.0.1:5432`. O Supabase local publica na **54322**. O erro que chega é
 * `ECONNREFUSED` numa porta que ninguém configurou — três camadas longe da
 * causa.
 *
 * ## O que se guarda
 *
 * Que os DOIS ramos devolvem a travessia completa. O teste vive em `tests/`
 * (não em `scripts/`) de propósito: importar o helper daqui é o que o traz para
 * dentro do `tsconfig`, que é a razão de fundo de o defeito ter passado.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  credenciaisSupabaseDeTeste,
  type CredenciaisSupabase,
} from "../../scripts/lib/env-de-teste";

const VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_APP_URL",
  "SUPABASE_DB_URL",
] as const;

const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let anterior: Record<string, string | undefined> = {};
let cwdAnterior = "";
let tmp = "";

beforeEach(() => {
  anterior = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
  // cwd próprio: a função lê `.env.local` de `process.cwd()`, e o do repo
  // aponta para a nuvem — ler o de verdade aqui seria medir outra coisa.
  cwdAnterior = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-de-teste-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdAnterior);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(anterior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function escreverEnvLocal(linhas: Record<string, string>): void {
  fs.writeFileSync(
    path.join(tmp, ".env.local"),
    Object.entries(linhas)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
}

/** Todo campo da travessia preenchido — é a propriedade, não um campo específico. */
function travessiaCompleta(c: CredenciaisSupabase): string[] {
  return (["url", "serviceRole", "dbUrl"] as const).filter((k) => c[k] === "");
}

describe("credenciaisSupabaseDeTeste — a travessia chega inteira", () => {
  it("ramo ARQUIVO devolve dbUrl", () => {
    escreverEnvLocal({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "srk-arquivo",
      SUPABASE_DB_URL: DB_URL,
    });
    const c = credenciaisSupabaseDeTeste();
    expect(c.origem).toBe("arquivo");
    expect(c.dbUrl).toBe(DB_URL);
    expect(travessiaCompleta(c)).toEqual([]);
  });

  it("ramo AMBIENTE devolve dbUrl — é o ramo que roda no CI", () => {
    // O workflow exporta URL + service role para `$GITHUB_ENV`. Sem este caso,
    // o defeito original passa: o ramo do arquivo cobre a máquina do dev e o
    // vermelho só aparece no CI.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk-ambiente";
    process.env.SUPABASE_DB_URL = DB_URL;
    const c = credenciaisSupabaseDeTeste();
    expect(c.origem).toBe("ambiente");
    expect(
      c.dbUrl,
      "sem isto o pg.Pool recebe undefined e tenta 127.0.0.1:5432 — o Supabase local está na 54322",
    ).toBe(DB_URL);
    expect(travessiaCompleta(c)).toEqual([]);
  });

  it("ambiente sem SUPABASE_DB_URL cai no arquivo em vez de devolver vazio", () => {
    // O caso EXATO do CI: as credenciais vêm do ambiente, a conexão direta não.
    // Desistir aqui é o que produzia o ECONNREFUSED.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk-ambiente";
    escreverEnvLocal({ SUPABASE_DB_URL: DB_URL });
    const c = credenciaisSupabaseDeTeste();
    expect(c.origem).toBe("ambiente");
    expect(c.dbUrl).toBe(DB_URL);
  });

  it("process.env continua vencendo o arquivo (a regra da função não mudou)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk-ambiente";
    process.env.SUPABASE_DB_URL = DB_URL;
    escreverEnvLocal({ SUPABASE_DB_URL: "postgresql://nao-use@producao:5432/postgres" });
    expect(credenciaisSupabaseDeTeste().dbUrl).toBe(DB_URL);
  });

  it("sem credencial nenhuma, lança em vez de devolver vazio", () => {
    // Guarda de vacuidade: se a função passasse a devolver objeto vazio, todos
    // os casos acima virariam comparações contra ausência de dado.
    expect(() => credenciaisSupabaseDeTeste()).toThrow(/credenciais do Supabase/i);
  });
});
