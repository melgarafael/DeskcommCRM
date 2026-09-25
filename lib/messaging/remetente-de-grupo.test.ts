import { describe, expect, it } from "vitest";
import { lerRemetenteDeGrupo, rotuloDoRemetente } from "./remetente-de-grupo";

describe("remetente de grupo", () => {
  it("lê o remetente gravado em metadata.group_sender", () => {
    const r = lerRemetenteDeGrupo({ raw_type: "chat", group_sender: { name: "Maria", phone: "+5521999990000", lid: null } });
    expect(r).toEqual({ name: "Maria", phone: "+5521999990000", lid: null });
  });
  it("devolve null quando não é mensagem de grupo ou o formato é outro", () => {
    expect(lerRemetenteDeGrupo({ raw_type: "chat" })).toBeNull();
    expect(lerRemetenteDeGrupo({ group_sender: "Maria" })).toBeNull();
    expect(lerRemetenteDeGrupo(null)).toBeNull();
  });
  it("rótulo prefere o nome, depois o telefone, depois 'Participante'", () => {
    expect(rotuloDoRemetente({ name: "Maria", phone: "+5521999990000", lid: null })).toBe("Maria · +5521999990000");
    expect(rotuloDoRemetente({ name: null, phone: "+5521999990000", lid: null })).toBe("+5521999990000");
    expect(rotuloDoRemetente({ name: null, phone: null, lid: "123" })).toBe("Participante");
  });
});
