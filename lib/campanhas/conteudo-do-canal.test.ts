/**
 * O conteúdo segue o que o número aceita — nunca uma escolha solta do corpo da
 * requisição. Estes casos não tocam o banco: o banco só é lido quando há um
 * modelo para conferir (ver `modelo-da-conexao.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { decidirConteudo, decidirVelocidade, fraseDaRecusa } from "./conteudo-do-canal";

const SEM_BANCO = new Proxy({} as SupabaseClient, {
  get() {
    throw new Error("este caso não deveria ler o banco");
  },
});

const base = { organizationId: "org", channelSessionId: "canal", extras: [] as string[] };

describe("decidirConteudo", () => {
  it("número por QR: texto livre, e as colunas de modelo ficam vazias", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "text", pedido: { message_body: "Oi" } });
    expect(r).toEqual({
      ok: true,
      modo: "text",
      colunas: {
        message_mode: "text",
        provider_template_name: null,
        provider_template_language: null,
        provider_template_variables: {},
      },
    });
  });

  it("pedir texto livre num número oficial é recusado — fora das 24 horas a plataforma recusa", async () => {
    const r = await decidirConteudo(SEM_BANCO, {
      ...base,
      modoDoCanal: "template",
      pedido: { message_mode: "text", message_body: "Oi" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modo_do_canal", status: 422 });
  });

  it("modelo em número por QR também é recusado", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "text", pedido: { message_mode: "template" } });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modo_do_canal" });
  });

  it("número oficial com números extras é recusado: cada número tem os próprios modelos", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, extras: ["outro"], modoDoCanal: "template", pedido: {} });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modelo_um_numero" });
  });

  it("rascunho oficial sem modelo ainda passa — quem cobra o conteúdo é a preparação", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: "template", pedido: {} });
    expect(r).toMatchObject({ ok: true, modo: "template", colunas: { message_mode: "template", provider_template_name: null } });
  });

  it("modelo sem idioma é recusado antes de ir ao banco", async () => {
    const r = await decidirConteudo(SEM_BANCO, {
      ...base,
      modoDoCanal: "template",
      pedido: { provider_template_name: "oferta" },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_modelo_inexistente" });
  });

  it("canal que não faz campanha (rede social)", async () => {
    const r = await decidirConteudo(SEM_BANCO, { ...base, modoDoCanal: null, pedido: {} });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_canal_indisponivel" });
  });
});

describe("decidirVelocidade", () => {
  // O número oficial cujo provedor faz broadcast, sem variável no modelo.
  const oficial = { modo: "template" as const, transmissao: true, variaveis: {} };

  it("rápida no número oficial passa; sem pedir, fica a que estava", () => {
    expect(decidirVelocidade({ ...oficial, pedida: "rapida", atual: "gradual" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ ...oficial, pedida: undefined, atual: "rapida" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ ...oficial, pedida: undefined, atual: "gradual" })).toEqual({ ok: true, velocidade: "gradual" });
  });

  it("rápida ou broadcast pedidos num número por QR são recusados com o código e a frase", () => {
    for (const pedida of ["rapida", "transmissao"] as const) {
      const r = decidirVelocidade({ pedida, atual: "gradual", modo: "text", transmissao: false, variaveis: {} });
      expect(r).toMatchObject({ ok: false, codigo: "campanha_velocidade_do_canal", status: 422 });
    }
  });

  it("campanha rápida ou por broadcast que troca para um número por QR volta a gradual em vez de travar no CHECK", () => {
    for (const atual of ["rapida", "transmissao"] as const) {
      expect(
        decidirVelocidade({ pedida: undefined, atual, modo: "text", transmissao: false, variaveis: {} }),
      ).toEqual({ ok: true, velocidade: "gradual" });
    }
  });

  it("broadcast passa no número que o faz, sem variável ou só com texto fixo", () => {
    expect(decidirVelocidade({ ...oficial, pedida: "transmissao", atual: "gradual" })).toEqual({
      ok: true,
      velocidade: "transmissao",
    });
    expect(
      decidirVelocidade({
        ...oficial,
        pedida: "transmissao",
        atual: "gradual",
        variaveis: { "1": { kind: "fixed", value: "Cafeteira Elétrica" } },
      }),
    ).toEqual({ ok: true, velocidade: "transmissao" });
  });

  it("broadcast com variável que muda por pessoa é recusado, e a frase nomeia a variável", () => {
    const r = decidirVelocidade({
      ...oficial,
      pedida: "transmissao",
      atual: "gradual",
      variaveis: { "1": { kind: "contact_first_name" }, "2": { kind: "fixed", value: "Cafeteira" } },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_transmissao_variavel", status: 422 });
    const frase = r.ok ? "" : fraseDaRecusa(r, (x) => x);
    expect(frase).toContain("({{1}})");
    expect(frase).not.toContain("{{2}}");
    expect(frase).not.toContain("{variaveis}");
  });

  it("trocar o modelo de uma campanha por broadcast para um com nome também é recusado", () => {
    const r = decidirVelocidade({
      ...oficial,
      pedida: undefined,
      atual: "transmissao",
      variaveis: { "1": { kind: "contact_name" } },
    });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_transmissao_variavel" });
  });

  it("broadcast pedido num número oficial cujo provedor não o faz é recusado; a que estava vira rápida", () => {
    const semTransmissao = { ...oficial, transmissao: false };
    expect(decidirVelocidade({ ...semTransmissao, pedida: "transmissao", atual: "gradual" })).toMatchObject({
      ok: false,
      codigo: "campanha_velocidade_do_canal",
    });
    expect(decidirVelocidade({ ...semTransmissao, pedida: undefined, atual: "transmissao" })).toEqual({
      ok: true,
      velocidade: "rapida",
    });
  });
});
