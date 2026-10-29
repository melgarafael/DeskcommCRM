import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHAVE_DO_METADADO,
  idExternoAceitavel,
  lerPagamentoDoMetadado,
  linkAceitavel,
  mensagemContemOLink,
  metadadoDoPagamento,
  valorEmTexto,
} from "./link";
import { SITUACOES_DO_RECEBIMENTO } from "./vocabulario";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261029134727_9043_recebimento_do_link_de_pagamento.sql",
);
const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

describe("metadado `pagamento` da mensagem", () => {
  it("monta o objeto com a forma que a issue pede: provedor, id, valor e status", () => {
    const m = metadadoDoPagamento({
      provedor: "infinitepay",
      id: "pay_123",
      valor: 15000,
      moeda: "BRL",
      status: "pendente",
      recebimento_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(m).toEqual({
      provedor: "infinitepay",
      id: "pay_123",
      valor: 15000,
      moeda: "BRL",
      status: "pendente",
      recebimento_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("lê de volta o que gravou, dentro de um metadata com OUTRAS chaves", () => {
    const pagamento = metadadoDoPagamento({
      provedor: "infinitepay",
      id: "pay_123",
      valor: 15000,
      moeda: "BRL",
      status: "paga",
      recebimento_id: "22222222-2222-4222-8222-222222222222",
    });
    const metadata = { queued_reason: "canal fora", [CHAVE_DO_METADADO]: pagamento };
    expect(lerPagamentoDoMetadado(metadata)).toEqual(pagamento);
  });

  it("⭐ metadata de mensagem comum (ou lixo) devolve null — nunca derruba a lista", () => {
    expect(lerPagamentoDoMetadado(null)).toBeNull();
    expect(lerPagamentoDoMetadado({})).toBeNull();
    expect(lerPagamentoDoMetadado("texto")).toBeNull();
    expect(lerPagamentoDoMetadado({ pagamento: { id: "x" } })).toBeNull();
    expect(
      lerPagamentoDoMetadado({
        pagamento: { provedor: "infinitepay", id: "x", valor: -1, moeda: "BRL", status: "pendente", recebimento_id: "y" },
      }),
    ).toBeNull();
    expect(
      lerPagamentoDoMetadado({
        pagamento: { provedor: "infinitepay", id: "x", valor: 100, moeda: "BRL", status: "inventado", recebimento_id: "y" },
      }),
    ).toBeNull();
  });
});

describe("o link que se aceita registrar", () => {
  it("https com host: aceito", () => {
    expect(linkAceitavel("https://checkout.infinitepay.io/abc")).toBe(true);
    expect(linkAceitavel("  https://pag.infinitepay.io/x?y=1  ")).toBe(true);
  });

  it("⭐ http, credencial embutida, sem host ou vazio: recusado", () => {
    expect(linkAceitavel("http://checkout.infinitepay.io/abc")).toBe(false);
    expect(linkAceitavel("https://user:senha@checkout.infinitepay.io/abc")).toBe(false);
    expect(linkAceitavel("https://localhost/abc")).toBe(false);
    expect(linkAceitavel("nao-e-url")).toBe(false);
    expect(linkAceitavel("")).toBe(false);
  });
});

describe("o id do pagamento no provedor", () => {
  it("aceita id alfanumérico com `._:-`", () => {
    expect(idExternoAceitavel("abc123")).toBe(true);
    expect(idExternoAceitavel("pay_1.2:3-4")).toBe(true);
  });

  it("⭐ recusa espaço, controle, caminho e vazio", () => {
    expect(idExternoAceitavel("")).toBe(false);
    expect(idExternoAceitavel("com espaco")).toBe(false);
    expect(idExternoAceitavel("a/b")).toBe(false);
    expect(idExternoAceitavel("a\nb")).toBe(false);
    expect(idExternoAceitavel("x".repeat(200))).toBe(false);
  });
});

describe("o link registrado é o link que está na conversa", () => {
  it("acha o link mesmo com quebra de linha e espaço sobrando em volta", () => {
    expect(mensagemContemOLink("Segue o link:\n\nhttps://pay.infinitepay.io/abc  \nqualquer dúvida", "https://pay.infinitepay.io/abc")).toBe(true);
  });

  it("⭐ link diferente (outro id) não está no corpo", () => {
    expect(mensagemContemOLink("https://pay.infinitepay.io/abc", "https://pay.infinitepay.io/xyz")).toBe(false);
    expect(mensagemContemOLink(null, "https://pay.infinitepay.io/abc")).toBe(false);
    expect(mensagemContemOLink("", "https://pay.infinitepay.io/abc")).toBe(false);
  });
});

describe("valor em texto", () => {
  it("centavos viram o valor da linha da timeline", () => {
    expect(valorEmTexto(15000, "BRL")).toContain("150");
  });
});

/**
 * A régua dupla do vocabulário: o CHECK da tabela e a lista do TypeScript são
 * duas porque o banco precisa recusar sozinho (um `psql` na mão não passa por
 * este arquivo). Este par é o que impede as duas de divergirem em silêncio.
 */
describe("vocabulário: SQL e TypeScript dizem a mesma lista", () => {
  it("os cinco estados do CHECK da migration 9043 são os do TypeScript", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const bloco = /pagamento_recebimentos_status_check check \(\s*status = any \(array\[([\s\S]*?)\]::text\[\]\)/.exec(sql);
    expect(bloco, "o CHECK de status sumiu da migration 9043").not.toBeNull();
    const doSql = [...bloco![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(doSql).toEqual([...SITUACOES_DO_RECEBIMENTO].sort());
  });

  it("o mesmo CHECK está no baseline (o clone que atualiza recebe a mesma régua)", () => {
    const baseline = readFileSync(BASELINE, "utf8");
    expect(baseline).toContain("pagamento_recebimentos_status_check check (");
    for (const s of SITUACOES_DO_RECEBIMENTO) {
      expect(baseline).toContain(`'${s}'`);
    }
  });
});
