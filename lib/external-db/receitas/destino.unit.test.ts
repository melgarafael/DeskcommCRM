/**
 * O destino do lead de interesse (Spec 25 R5): forma (Zod strict) e conferência
 * contra a organização, com um banco em memória que de fato aplica `organization_id`.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { bancoEmMemoria } from "../../../tests/helpers/tabelas-em-memoria";
import { instanciaDeReceitaSchemaItem, lerReceitasDoBanco, validarDestinoDaInstancia } from "./instancias";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const FUNIL = "66666666-6666-4666-8666-666666666666";
const ETAPA = "77777777-7777-4777-8777-777777777777";
const FUNIL_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const base = {
  id: "55555555-5555-4555-8555-555555555555",
  receita: "woocommerce-produtos",
  rotulo: "Produtos",
  descricao: "",
  fixos: { prefixo: "wp_" },
  ativa: true,
};

function banco(extra: Record<string, Record<string, unknown>[]> = {}) {
  return bancoEmMemoria({
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, is_archived: false }],
    crm_stages: [{ id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, is_archived: false, is_won: false, is_lost: false }],
    ...extra,
  }) as unknown as SupabaseClient;
}

describe("forma do destino", () => {
  it("instância sem destino continua válida (dado antigo)", () => {
    expect(instanciaDeReceitaSchemaItem.safeParse(base).success).toBe(true);
  });
  it("aceita pipeline_id + stage_id uuid", () => {
    const r = instanciaDeReceitaSchemaItem.safeParse({ ...base, destino: { pipeline_id: FUNIL, stage_id: ETAPA } });
    expect(r.success).toBe(true);
  });
  it("recusa chave estranha, uuid inválido e destino incompleto", () => {
    for (const destino of [
      { pipeline_id: FUNIL, stage_id: ETAPA, organization_id: ORG },
      { pipeline_id: "x", stage_id: ETAPA },
      { pipeline_id: FUNIL },
    ]) {
      expect(instanciaDeReceitaSchemaItem.safeParse({ ...base, destino }).success).toBe(false);
    }
  });
  it("o que vem do banco com destino malformado falha FECHADO (lista inteira inválida)", () => {
    expect(lerReceitasDoBanco([{ ...base, destino: { pipeline_id: "x", stage_id: "y" } }]).ok).toBe(false);
  });
});

describe("validarDestinoDaInstancia", () => {
  it("funil e etapa da organização, etapa do funil: ok", async () => {
    expect(await validarDestinoDaInstancia(banco(), ORG, { pipeline_id: FUNIL, stage_id: ETAPA })).toEqual({ ok: true });
  });
  it("funil de OUTRA organização: inexistente (não confirma que existe)", async () => {
    const r = await validarDestinoDaInstancia(banco(), OUTRA, { pipeline_id: FUNIL, stage_id: ETAPA });
    expect(r).toEqual({ ok: false, motivo: "funil_inexistente" });
  });
  it("etapa de OUTRA organização com funil da própria", async () => {
    const b = banco({
      crm_stages: [{ id: ETAPA, organization_id: OUTRA, pipeline_id: FUNIL, is_archived: false, is_won: false, is_lost: false }],
    });
    const r = await validarDestinoDaInstancia(b, ORG, { pipeline_id: FUNIL, stage_id: ETAPA });
    expect(r).toEqual({ ok: false, motivo: "etapa_inexistente" });
  });
  it("etapa de outro funil da mesma organização", async () => {
    const r = await validarDestinoDaInstancia(banco(), ORG, { pipeline_id: FUNIL_2, stage_id: ETAPA });
    // FUNIL_2 não existe aqui; com ele existindo, a etapa continua sendo do FUNIL
    expect(r.ok).toBe(false);
    const b = banco({
      crm_pipelines: [
        { id: FUNIL, organization_id: ORG, is_archived: false },
        { id: FUNIL_2, organization_id: ORG, is_archived: false },
      ],
    });
    expect(await validarDestinoDaInstancia(b, ORG, { pipeline_id: FUNIL_2, stage_id: ETAPA })).toEqual({
      ok: false,
      motivo: "etapa_de_outro_funil",
    });
  });
  it("funil arquivado, etapa arquivada, ganha ou perdida: recusados", async () => {
    expect((await validarDestinoDaInstancia(banco({ crm_pipelines: [{ id: FUNIL, organization_id: ORG, is_archived: true }] }), ORG, { pipeline_id: FUNIL, stage_id: ETAPA })).ok).toBe(false);
    for (const marca of [{ is_archived: true }, { is_won: true }, { is_lost: true }]) {
      const b = banco({
        crm_stages: [{ id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, is_archived: false, is_won: false, is_lost: false, ...marca }],
      });
      expect((await validarDestinoDaInstancia(b, ORG, { pipeline_id: FUNIL, stage_id: ETAPA })).ok, JSON.stringify(marca)).toBe(false);
    }
  });
});
