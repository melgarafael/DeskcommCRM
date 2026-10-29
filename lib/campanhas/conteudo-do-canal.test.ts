/**
 * O conteúdo segue o que o número aceita — nunca uma escolha solta do corpo da
 * requisição. Estes casos não tocam o banco: o banco só é lido quando há um
 * modelo para conferir (ver `modelo-da-conexao.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { decidirConteudo, decidirVelocidade } from "./conteudo-do-canal";

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
  it("rápida no número oficial passa; sem pedir, fica a que estava", () => {
    expect(decidirVelocidade({ pedida: "rapida", atual: "gradual", modo: "template" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ pedida: undefined, atual: "rapida", modo: "template" })).toEqual({ ok: true, velocidade: "rapida" });
    expect(decidirVelocidade({ pedida: undefined, atual: "gradual", modo: "template" })).toEqual({ ok: true, velocidade: "gradual" });
  });

  it("rápida pedida num número por QR é recusada com o código e a frase", () => {
    const r = decidirVelocidade({ pedida: "rapida", atual: "gradual", modo: "text" });
    expect(r).toMatchObject({ ok: false, codigo: "campanha_velocidade_do_canal", status: 422 });
  });

  it("campanha rápida que troca para um número por QR volta a gradual em vez de travar no CHECK", () => {
    expect(decidirVelocidade({ pedida: undefined, atual: "rapida", modo: "text" })).toEqual({ ok: true, velocidade: "gradual" });
  });
});
