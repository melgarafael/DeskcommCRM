/**
 * A RÉGUA DE POSSE DO #3746, sem banco.
 *
 * As duas rotas (`PATCH /contacts/[id]/carteira` e
 * `POST /ai/followups/enrollments`) perguntam a MESMA coisa: "este cliente é
 * deste atendente?". A resposta é `decidirPosse`, e é aqui que ela é medida com
 * os três papéis e as duas formas de posse — sem dublê, sem PostgREST, sem
 * organização.
 *
 * A regra que estes casos prendem:
 *
 *   manager+            → pode, sempre (papel de gerência não tem escopo de posse);
 *   agent com a conversa → pode (a conversa do cliente está atribuída a ele);
 *   agent com a carteira → pode (o contato já é dele);
 *   agent sem nenhuma   → NÃO pode (é o caso que, sem escopo, viraria "qualquer
 *                         atendente muda a carteira de qualquer cliente");
 *   viewer              → NÃO pode (não chega à rota, que cobra `agent`, mas a
 *                         régua não mente sobre o papel que só lê).
 *
 * E a diferença entre as duas ações (doc 250): na CARTEIRA, a conversa só dá
 * posse sobre o cliente SEM dono — o da carteira de um colega é do gerente
 * (1-B). No FOLLOW-UP a conversa basta (2-A).
 */
import { describe, expect, it } from "vitest";

import { decidirPosse } from "./posse";

function decisao(papel: string | null, donoDaConversa: boolean, contatoNaCarteira: boolean) {
  return decidirPosse({ papel, acao: "carteira", donoDaConversa, contatoNaCarteira, carteiraDeOutro: false });
}

describe("#3746 — quem pode mexer no cliente", () => {
  it("`agent` dono da CONVERSA pode", () => {
    expect(decisao("agent", true, false)).toEqual({ pode: true, motivo: "conversa" });
  });

  it("`agent` com o CONTATO na carteira dele pode", () => {
    expect(decisao("agent", false, true)).toEqual({ pode: true, motivo: "carteira" });
  });

  it("⭐ `agent` que não é dono de nada NÃO pode", () => {
    expect(decisao("agent", false, false)).toEqual({ pode: false, motivo: "fora_da_posse" });
  });

  it("as duas posses ao mesmo tempo continuam podendo (o OR não tem ordem)", () => {
    expect(decisao("agent", true, true).pode).toBe(true);
  });

  it("`manager` pode sem posse nenhuma — anti-regressão do que já funcionava", () => {
    expect(decisao("manager", false, false)).toEqual({ pode: true, motivo: "papel" });
  });

  it("`admin` pode sem posse nenhuma", () => {
    expect(decisao("admin", false, false)).toEqual({ pode: true, motivo: "papel" });
  });

  it("`viewer` não pode, mesmo com o contato na carteira dele", () => {
    expect(decisao("viewer", false, true)).toEqual({ pode: false, motivo: "fora_da_posse" });
  });

  it("papel ausente/desconhecido não pode — falha fechada", () => {
    expect(decisao(null, false, false).pode).toBe(false);
    expect(decisao("papel-que-nao-existe", false, false).pode).toBe(false);
  });
});

describe("doc 250 — a carteira de OUTRO vendedor não sai pela conversa", () => {
  const deOutro = (papel: string, acao: "carteira" | "follow_up") =>
    decidirPosse({ papel, acao, donoDaConversa: true, contatoNaCarteira: false, carteiraDeOutro: true });

  it("⭐ 1-B: `agent` com a conversa NÃO tira o cliente da carteira de um colega", () => {
    expect(deOutro("agent", "carteira")).toEqual({ pode: false, motivo: "carteira_de_outro" });
  });

  it("2-A: no follow-up a conversa basta, mesmo com o cliente na carteira de outro", () => {
    expect(deOutro("agent", "follow_up")).toEqual({ pode: true, motivo: "conversa" });
  });

  it("CONTROLE: `manager` tira o cliente da carteira de um colega", () => {
    expect(deOutro("manager", "carteira")).toEqual({ pode: true, motivo: "papel" });
  });

});
