import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * 0759 — os códigos de recuperação gravados antes do HMAC saem, e os de agora
 * sobrevivem a qualquer número de `update.sh`.
 *
 * Roda o TEXTO do apêndice do baseline e o da migration, não uma cópia: um
 * critério reimplementado aqui continuaria verde com o baseline sabotado.
 *
 * Forma antiga: o `Buffer` que o supabase-js serializava como o texto JSON
 * `{"type":"Buffer","data":[...]}`. Forma de agora: o HMAC-SHA256 de 32 bytes
 * que `hashRecoveryCode` devolve como literal `\x` + 64 hex.
 */

const RAIZ = process.cwd();
const MARCA = "-- ---- códigos de recuperação na forma antiga saem (migration 0759) ----";

function blocoDoBaseline(): string | null {
  const texto = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const inicio = texto.indexOf(MARCA);
  if (inicio === -1) return null;
  const resto = texto.slice(inicio + MARCA.length);
  const fim = resto.indexOf("\n-- ---- ");
  return resto.slice(0, fim === -1 ? undefined : fim);
}

function migration(): string {
  const dir = join(RAIZ, "supabase", "migrations");
  const nome = readdirSync(dir).find((f) => /_0759_codigos_de_recuperacao_antigos_saem\.sql$/.test(f));
  if (!nome) throw new Error("a migration 0759 sumiu de supabase/migrations — o instrumento perdeu o alvo");
  return readFileSync(join(dir, nome), "utf8");
}

const USUARIO = "dddd0759-0000-4000-8000-000000000001";
const NOVO = `'\\x${"ab".repeat(32)}'`;
const NOVO_USADO = `'\\x${"cd".repeat(32)}'`;
// Dois códigos reais na forma antiga (sha256 de "ABCD2345" e de "ZZZZ9999", serializados
// como o supabase-js fazia). Um digest de 32 bytes vira no mínimo 87 caracteres de JSON.
const ANTIGO = `convert_to('{"type":"Buffer","data":[160,13,118,100,110,186,145,176,87,132,21,84,213,200,51,79,73,141,197,146,237,116,75,206,64,79,33,254,39,28,211,110]}', 'UTF8')`;
const ANTIGO_USADO = `convert_to('{"type":"Buffer","data":[128,8,15,241,111,71,205,144,235,125,54,61,219,69,188,74,181,47,32,229,247,230,176,83,114,250,182,248,232,6,242,252]}', 'UTF8')`;

/**
 * Semeia 2 antigos + 2 novos, aplica `bloco` `vezes` vezes, devolve o que ficou.
 * O psql também imprime as etiquetas dos comandos (BEGIN, DELETE 2…); a linha
 * do resultado é a que começa com `RESTOU=`.
 */
function aplicar(bloco: string, vezes: number): string {
  const saida = sql(`
    begin;
    insert into auth.users (id, email) values ('${USUARIO}', 'inv-0759@invariant.test') on conflict do nothing;
    delete from public.user_recovery_codes where user_id = '${USUARIO}';
    insert into public.user_recovery_codes (user_id, code_hash, used_at) values
      ('${USUARIO}', ${ANTIGO}, null),
      ('${USUARIO}', ${ANTIGO_USADO}, now()),
      ('${USUARIO}', ${NOVO}::bytea, null),
      ('${USUARIO}', ${NOVO_USADO}::bytea, now());
    ${Array.from({ length: vezes }, () => bloco).join("\n")}
    select 'RESTOU=' || coalesce(string_agg(octet_length(code_hash)::text || ':' || (used_at is not null)::text, ','
                    order by encode(code_hash, 'hex')), '')
      from public.user_recovery_codes where user_id = '${USUARIO}';
    rollback;`);
  const linha = saida.split("\n").find((l) => l.startsWith("RESTOU="));
  if (linha === undefined) throw new Error(`sem a linha RESTOU= na saída do psql:\n${saida}`);
  return linha.slice("RESTOU=".length);
}

describe("0759 — códigos de recuperação antigos saem, os novos ficam", () => {
  it("CONTROLE: sem o bloco, os quatro estão lá (o semeio produz as duas formas)", () => {
    expect(aplicar("", 0)).toBe("141:true,141:false,32:false,32:true");
  });

  it("o apêndice do baseline apaga só a forma antiga", () => {
    const bloco = blocoDoBaseline();
    expect(bloco, "não achei o bloco da 0759 no baseline.sql — o instrumento perdeu o alvo").not.toBeNull();
    expect(aplicar(bloco ?? "", 1)).toBe("32:false,32:true");
  });

  it("re-aplicar o apêndice três vezes (três update.sh) não apaga código novo", () => {
    expect(aplicar(blocoDoBaseline() ?? "", 3)).toBe("32:false,32:true");
  });

  it("a migration faz o mesmo que o apêndice, e também é idempotente", () => {
    expect(aplicar(migration(), 2)).toBe("32:false,32:true");
  });
});
