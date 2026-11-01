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
 */
import { describe, expect, it } from "vitest";

import { decidirPosse } from "./posse";

function decisao(papel: string | null, donoDaConversa: boolean, contatoNaCarteira: boolean) {
  return decidirPosse({ papel, donoDaConversa, contatoNaCarteira });
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
