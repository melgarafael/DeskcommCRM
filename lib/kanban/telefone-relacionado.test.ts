import { describe, expect, it } from "vitest";
import { decidirTelefone } from "./telefone-relacionado";

/**
 * O "+ telefone" da lista de relacionados (#3669, fatia 1b).
 *
 * A regra é pequena, mas é onde mora o erro caro: o mesmo cliente digitado em
 * outro formato virando dois contatos, e a ligação duplicada de quem já está
 * relacionado. Testada fora do componente de propósito — não precisa de tela.
 */
describe("decidirTelefone", () => {
  const contatoExplicito = { id: "c-1", phone_number: "+5541985337818" };

  it("recusa número que não dá para normalizar", () => {
    expect(decidirTelefone("", [], [])).toEqual({ tipo: "invalido" });
    expect(decidirTelefone("abc", [], [])).toEqual({ tipo: "invalido" });
    expect(decidirTelefone("11", [], [])).toEqual({ tipo: "invalido" });
  });

  it("cria quando o número não corresponde a nenhum contato conhecido", () => {
    const decisao = decidirTelefone("(41) 98888-7777", [], [contatoExplicito]);

    expect(decisao.tipo).toBe("criar_e_ligar");
    if (decisao.tipo === "criar_e_ligar") {
      expect(decisao.canonico).toContain("988887777");
    }
  });

  it("liga o contato que já existe em vez de criar outro", () => {
    const decisao = decidirTelefone(
      "(41) 98533-7818",
      [],
      [contatoExplicito],
    );

    expect(decisao).toEqual({ tipo: "ligar_existente", contactId: "c-1" });
  });

  it("acha o contato mesmo quando o número foi digitado em outro formato", () => {
    const contatoSemNove = { id: "c-2", phone_number: "+554185337818" };

    // com máscara e sem o +55: o mesmo telefone, escrito de outro jeito
    const decisao = decidirTelefone("41985337818", [], [contatoSemNove]);

    expect(decisao).toEqual({ tipo: "ligar_existente", contactId: "c-2" });
  });

  it("avisa em vez de duplicar quando o contato já está relacionado ao negócio", () => {
    const decisao = decidirTelefone(
      "+55 41 98533-7818",
      [{ contact_id: "c-1" }],
      [contatoExplicito],
    );

    expect(decisao).toEqual({ tipo: "ja_relacionado", contactId: "c-1" });
  });

  it("ignora contato conhecido sem telefone na comparação", () => {
    const semTelefone = { id: "c-3", phone_number: null };
    const decisao = decidirTelefone("(41) 98888-7777", [], [semTelefone]);

    expect(decisao.tipo).toBe("criar_e_ligar");
  });
});
