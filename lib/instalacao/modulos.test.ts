/**
 * O módulo opcional nasce DESLIGADO e só o valor `ligado` o liga (doc 37).
 * Falha fechada: banco que não responde não abre a porta para o banco de outro
 * sistema.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { abrirAcesso } from "@/lib/external-db/acesso";

import { esquecerMemoDosModulos, MEMO_DO_MODULO_MS, moduloLigadoComMemo, modulosLigados } from "./modulos";

function banco(resposta: { data?: unknown; error?: unknown } | Error) {
  const from = vi.fn(() => ({
    select: () => ({
      in: async () => {
        if (resposta instanceof Error) throw resposta;
        return { data: resposta.data ?? null, error: resposta.error ?? null };
      },
    }),
  }));
  return { db: { from } as unknown as SupabaseClient, from };
}

describe("modulosLigados", () => {
  it("sem linha, o banco externo está desligado", async () => {
    expect(await modulosLigados(banco({ data: [] }).db)).toEqual([]);
  });

  it("só `ligado` liga — `desligado` e lixo não", async () => {
    const ligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }];
    expect(await modulosLigados(banco({ data: ligado }).db)).toEqual(["banco_externo"]);
    const desligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "desligado" }];
    expect(await modulosLigados(banco({ data: desligado }).db)).toEqual([]);
    const lixo = [{ chave: "MODULO_BANCO_EXTERNO", valor: "true" }];
    expect(await modulosLigados(banco({ data: lixo }).db)).toEqual([]);
  });

  it("cada módulo tem a sua linha — ligar um não liga o outro", async () => {
    const soFluxos = [{ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }];
    expect(await modulosLigados(banco({ data: soFluxos }).db)).toEqual(["fluxos_atendimento"]);
    const osDois = [
      { chave: "MODULO_BANCO_EXTERNO", valor: "ligado" },
      { chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" },
    ];
    expect(await modulosLigados(banco({ data: osDois }).db)).toEqual([
      "banco_externo",
      "fluxos_atendimento",
    ]);
  });

  it("banco que recusa ou lança = desligado, sem lançar", async () => {
    expect(await modulosLigados(banco({ error: { code: "42P01", message: "x" } }).db)).toEqual([]);
    expect(await modulosLigados(banco(new Error("rede")).db)).toEqual([]);
  });
});

describe("abrirAcesso com o módulo desligado", () => {
  it("recusa antes de carregar a conexão — nenhuma credencial é lida", async () => {
    const { db, from } = banco({ data: [] });
    const acesso = await abrirAcesso(db, "org", "conexao");
    expect(acesso).toEqual({ ok: false, motivo: "modulo_desligado" });
    // Uma consulta só: a da chave. A tabela de conexões nem foi tocada.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("platform_config");
  });
});

describe("moduloLigadoComMemo (turno do agente)", () => {
  it("dentro do prazo do memo, uma leitura só; vencido, lê de novo", async () => {
    esquecerMemoDosModulos();
    const { db, from } = banco({ data: [{ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }] });
    expect(await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000)).toBe(true);
    expect(await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000 + MEMO_DO_MODULO_MS - 1)).toBe(true);
    expect(from).toHaveBeenCalledTimes(1);
    await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000 + MEMO_DO_MODULO_MS + 1);
    expect(from).toHaveBeenCalledTimes(2);
  });
});

