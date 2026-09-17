import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";

/**
 * A ÚNICA divergência possível entre a etiqueta que o banco escreve e a que a
 * tela oferece no filtro.
 *
 * Quem grava `cliente` é SQL (`fn_recalcular_cliente_do_contato`, migration
 * 0262); quem filtra por ela é TypeScript. São dois literais em dois idiomas,
 * sem nada que os obrigue a concordar — e o dia em que discordarem, o filtro
 * "cliente" não acha ninguém, sem erro nenhum para investigar. É o modo de falha
 * mais caro que uma feature destas tem: silencioso e plausível ("então não temos
 * clientes marcados ainda").
 *
 * O literal mora só em constantes `c_etiqueta`, e são DUAS, uma por função que
 * precisa saber qual é a etiqueta: `fn_recalcular_cliente_do_contato` (que a
 * põe e a tira) e `fn_colunas_de_cliente_sao_do_sistema` (o BEFORE UPDATE que
 * lê de quem ela é). O teste cobra as três coisas: TODA constante é igual à do
 * TypeScript, o NÚMERO delas é o das funções que a declaram — uma terceira
 * cópia é uma decisão, não um acidente —, e nenhuma escrita ou comparação de
 * array usa um literal solto que pudesse divergir delas.
 *
 * O COMPORTAMENTO — de quem é a etiqueta, quando ela sai e volta, quantas vezes
 * o evento sai — não se prova lendo arquivo. Mora em
 * `tests/invariants/cliente-nasce-do-agendamento.test.ts`, contra Postgres real.
 *
 * O teste lê o ARQUIVO, e não o banco, de propósito: assim ele roda em
 * `test:unit` (sem Postgres) e reprova o PR que muda um lado só.
 */
const MIGRATION = join(process.cwd(), "supabase/migrations/20260915180000_0262_cliente_pela_agenda.sql");
const BASELINE = join(process.cwd(), "supabase/baseline.sql");

const CONSTANTE = /c_etiqueta constant text := '([^']+)'/g;

describe("a etiqueta de cliente", () => {
  it("é a mesma no TypeScript e em TODA constante SQL, e elas são duas", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const capturas = [...sql.matchAll(CONSTANTE)].map((m) => m[1]);
    expect(capturas, "a migration 0262 declara a etiqueta só em constantes, todas iguais").toEqual([
      TAG_DE_CLIENTE,
      TAG_DE_CLIENTE,
    ]);
  });

  it("nenhuma escrita ou comparação de array usa literal solto no lugar da constante", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // Só o CÓDIGO: comentário que cite `array_append(tags, 'x')` não escreve nada.
    const codigo = sql
      .split("\n")
      .map((linha) => linha.replace(/--.*$/, ""))
      .join("\n");
    const soltos = codigo.match(/array_(append|remove)\([^)]*'|'[^']*'\s*=\s*any\(/g) ?? [];
    expect(soltos).toEqual([]);
  });

  it("o baseline carrega a mesma constante, os triggers de UPDATE e DELETE e o dono da etiqueta — é ele que o self-hoster aplica", () => {
    // Migração que só entra em `migrations/` não chega a quem instalou pelo kit.
    const baseline = readFileSync(BASELINE, "utf8");
    expect(baseline).toContain("trg_agendamento_recalcula_cliente");
    expect(baseline).toContain("trg_agendamento_apagado_recalcula_cliente");
    expect(baseline).toContain("add column if not exists client_tag_by_system");
    expect(baseline).toContain("add column if not exists client_recognized_at");
    // A GUARDA de `contacts`: é ela que faz a remoção à mão ser respeitada NA
    // HORA e que recusa a escrita de sessão nas três colunas. Migration que só
    // entra em `migrations/` não chega a quem instalou pelo kit — e aqui a
    // ausência não dá erro nenhum, só devolve o comportamento antigo.
    expect(baseline).toContain("create or replace function public.fn_colunas_de_cliente_sao_do_sistema()");
    expect(baseline).toContain("create trigger trg_contato_colunas_de_cliente");
    expect(baseline).toContain("colunas_de_cliente_sao_do_sistema' using errcode = '42501'");
    // O anúncio da escrita do sistema. Sem ele a guarda barra o próprio trigger
    // e marcar um horário passa a dar 42501 — o pior desfecho possível, porque
    // o `update.sh` do clone aplicaria a guarda sem o anúncio.
    expect(baseline).toContain("set_config('deskcomm.cliente_pela_agenda', 'on', true)");
    const constantesDoBaseline = [...baseline.matchAll(CONSTANTE)].map((m) => m[1]);
    expect(constantesDoBaseline).toEqual([TAG_DE_CLIENTE, TAG_DE_CLIENTE]);
  });
});
