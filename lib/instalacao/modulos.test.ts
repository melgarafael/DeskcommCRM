/**
 * `MODULOS_OPCIONAIS` tem DOIS mecanismos por baixo (ver o cabeçalho de `./modulos.ts`):
 *
 *  - `banco_externo`: uma FLAG em `platform_config` — só o valor `ligado` liga (doc 37).
 *  - `honorarios`: um MÓDULO DE TABELA (ADR-0002) — a fonte é `modulos_instalados.estado`,
 *    escrita só por `fn_modulo_instalar`, nunca por esta tela.
 *
 * Os dois falham fechado: banco que não responde, ou que lança, nunca liga um módulo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { abrirAcesso } from "@/lib/external-db/acesso";

import { modulosLigados } from "./modulos";

type Resposta = { data?: unknown; error?: unknown } | Error;

/**
 * Um builder por tabela, chamável tanto como `.select().in()` (flag) quanto como
 * `.select().in().eq()` (módulo de tabela) — os dois formatos que `modulosLigados` usa,
 * cada um resolvendo pela mesma promessa no fim da cadeia (como o cliente real: qualquer
 * ponto da cadeia é `await`-ável).
 */
function banco(porTabela: Record<string, Resposta> = {}) {
  const from = vi.fn((table: string) => {
    const resposta = porTabela[table] ?? { data: [], error: null };
    const resolver = () =>
      resposta instanceof Error
        ? Promise.reject(resposta)
        : Promise.resolve({ data: resposta.data ?? null, error: resposta.error ?? null });
    const builder = {
      select: () => builder,
      in: () => builder,
      eq: () => builder,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolver().then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}

describe("modulosLigados — banco_externo (flag em platform_config)", () => {
  it("sem linha, o banco externo está desligado", async () => {
    expect(await modulosLigados(banco().db)).toEqual([]);
  });

  it("só `ligado` liga — `desligado` e lixo não", async () => {
    const ligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: ligado } }).db)).toEqual([
      "banco_externo",
    ]);
    const desligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "desligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: desligado } }).db)).toEqual([]);
    const lixo = [{ chave: "MODULO_BANCO_EXTERNO", valor: "true" }];
    expect(await modulosLigados(banco({ platform_config: { data: lixo } }).db)).toEqual([]);
  });

  it("banco que recusa ou lança = desligado, sem lançar", async () => {
    expect(
      await modulosLigados(banco({ platform_config: { error: { code: "42P01" } } }).db),
    ).toEqual([]);
    expect(await modulosLigados(banco({ platform_config: new Error("rede") }).db)).toEqual([]);
  });
});

describe("modulosLigados — honorarios (módulo de tabela, ADR-0002)", () => {
  it("sem linha em modulos_instalados, honorarios está desligado", async () => {
    expect(await modulosLigados(banco().db)).toEqual([]);
  });

  it("estado 'ativo' liga; 'suspenso' NÃO liga — D6 (falha alto na reaplicação)", async () => {
    const ativo = [{ modulo: "honorarios", estado: "ativo" }];
    expect(await modulosLigados(banco({ modulos_instalados: { data: ativo } }).db)).toEqual([
      "honorarios",
    ]);
    // O `.eq('estado','ativo')' da query real já filtra suspenso no servidor — o fake
    // simula exatamente o que o Postgrest devolveria: nenhuma linha.
    expect(await modulosLigados(banco({ modulos_instalados: { data: [] } }).db)).toEqual([]);
  });

  it("banco que recusa ou lança = desligado, sem lançar (o outro mecanismo segue funcionando)", async () => {
    expect(
      await modulosLigados(banco({ modulos_instalados: { error: { code: "42P01" } } }).db),
    ).toEqual([]);
    expect(await modulosLigados(banco({ modulos_instalados: new Error("rede") }).db)).toEqual([]);
  });

  it("os dois mecanismos somam quando ambos estão ligados", async () => {
    const resultado = await modulosLigados(
      banco({
        platform_config: { data: [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }] },
        modulos_instalados: { data: [{ modulo: "honorarios", estado: "ativo" }] },
      }).db,
    );
    expect(resultado.sort()).toEqual(["banco_externo", "honorarios"]);
  });
});

describe("abrirAcesso com o módulo desligado", () => {
  it("recusa antes de carregar a conexão — nenhuma credencial é lida", async () => {
    const { db, from } = banco();
    const acesso = await abrirAcesso(db, "org", "conexao");
    expect(acesso).toEqual({ ok: false, motivo: "modulo_desligado" });
    // As DUAS consultas de `modulosLigados` (flag + módulo de tabela) — e mais nenhuma:
    // a tabela de conexões nem é tocada quando o módulo já está desligado.
    expect(from).toHaveBeenCalledTimes(2);
    expect(from).toHaveBeenCalledWith("platform_config");
    expect(from).toHaveBeenCalledWith("modulos_instalados");
  });
});
