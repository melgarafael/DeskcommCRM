import { describe, expect, it } from "vitest";

import { resolverProvedor } from "@/lib/fiscal/provedor";
import { montarPayloadSped, type EmitenteSped, type ItemSped } from "@/lib/fiscal/sped-payload";

/**
 * O CONTRATO SPED — cerca do ATT.txt F3 (fiscal via sidecar).
 *
 * Imposto presumido é crime fiscal: o que falta volta nomeando o campo.
 */
const EMITENTE: EmitenteSped = {
  serie: "1",
  natureza_operacao: "Venda",
  cfop_padrao: "5102",
  emitente_documento: "12345678000190",
  ie: "123456789",
  crt: "1",
  logradouro: "Rua A",
  numero_end: "100",
  bairro: "Centro",
  municipio: "São Paulo",
  codigo_municipio: "3550308",
  uf: "SP",
  cep: "01001000",
  ambiente: "homologacao",
  certificado_path: "/certs/empresa.pfx",
};

const ITEM: ItemSped = {
  codigo: "AG-5L",
  descricao: "Água Sanitária",
  ncm: "28289011",
  cfop: null,
  unidade: null,
  quantidade: 2,
  preco_cents: 5000,
  desconto_pct: 0,
};

const PEDIDO = { numero: 1, nome: "Mercado", documento: null, frete_cents: 0 };

describe("montarPayloadSped", () => {
  it("monta quando está tudo presente", () => {
    const r = montarPayloadSped(EMITENTE, "senha", PEDIDO, [ITEM]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.certificado_arquivo).toBe("/certs/empresa.pfx");
      expect((r.payload.itens[0] as { unidade: string }).unidade).toBe("UN");
    }
  });

  it("nomeia o NCM ausente em vez de presumir", () => {
    const r = montarPayloadSped(EMITENTE, "senha", PEDIDO, [{ ...ITEM, ncm: null }]);
    expect(r).toEqual({ ok: false, falta: 'NCM do produto "Água Sanitária"' });
  });

  it("nomeia cada ausência na ordem de dependência", () => {
    expect(montarPayloadSped({ ...EMITENTE, emitente_documento: null }, "s", PEDIDO, [ITEM])).toEqual({
      ok: false,
      falta: "CNPJ do emitente (configuração fiscal)",
    });
    expect(montarPayloadSped({ ...EMITENTE, codigo_municipio: null }, "s", PEDIDO, [ITEM])).toEqual({
      ok: false,
      falta: "Código IBGE do município (configuração fiscal)",
    });
    expect(montarPayloadSped(EMITENTE, "", PEDIDO, [ITEM])).toEqual({
      ok: false,
      falta: "Senha do certificado",
    });
    expect(montarPayloadSped(EMITENTE, "s", PEDIDO, [])).toEqual({
      ok: false,
      falta: "Ao menos 1 item",
    });
  });
});

describe("resolverProvedor", () => {
  it("default é stub, mesmo com sidecar no ar", () => {
    process.env.FISCAL_SIDECAR_URL = "http://fiscal:8080";
    process.env.FISCAL_SIDECAR_SECRET = "x";
    expect(resolverProvedor({ provedor: "stub" })).toBe("stub");
    expect(resolverProvedor({ provedor: null })).toBe("stub");
    delete process.env.FISCAL_SIDECAR_URL;
    delete process.env.FISCAL_SIDECAR_SECRET;
  });

  it("spednfe sem sidecar cai no stub — nunca em emissão pela metade", () => {
    delete process.env.FISCAL_SIDECAR_URL;
    delete process.env.FISCAL_SIDECAR_SECRET;
    expect(resolverProvedor({ provedor: "spednfe" })).toBe("stub");
  });

  it("spednfe com config + sidecar vai ao sidecar", () => {
    process.env.FISCAL_SIDECAR_URL = "http://fiscal:8080";
    process.env.FISCAL_SIDECAR_SECRET = "x";
    expect(resolverProvedor({ provedor: "spednfe" })).toBe("spednfe");
    delete process.env.FISCAL_SIDECAR_URL;
    delete process.env.FISCAL_SIDECAR_SECRET;
  });
});
