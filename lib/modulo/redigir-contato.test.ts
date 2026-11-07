import { describe, expect, it } from "vitest";

import { moduloSemContato, redigirContatoParaModulo } from "./redigir-contato";

const SEM = { actor: { type: "module" }, contatoVisivel: false };
const COM = { actor: { type: "module" }, contatoVisivel: true };
const SESSAO = { actor: { type: "user" } };

const conversa = {
  id: "c1",
  contact_id: "k1",
  channel: "whatsapp",
  last_message_preview: "oi",
  contacts: { id: "k1", display_name: "Ana", name: "Ana", phone_number: "+5562999", tags: ["vip"], is_blocked: true },
  channel_sessions: { phone_number: "+5562111", display_name: "Canal" },
};

describe("redigirContatoParaModulo", () => {
  it("módulo sem contatos: o objeto do contato vira só o id; o resto da conversa fica", () => {
    const r = redigirContatoParaModulo(SEM, [conversa]);
    // `redacted: true` diz ao módulo que o dado foi retirado (e não que é falso): sem is_blocked, ninguém pode
    // concluir "não há bloqueados".
    expect(r[0]!.contacts).toEqual({ id: "k1", redacted: true });
    expect(r[0]!.contact_id).toBe("k1");
    expect(r[0]!.channel).toBe("whatsapp");
    expect(r[0]!.last_message_preview).toBe("oi");
    // o número do CANAL é da empresa, não de contato: fica
    expect(r[0]!.channel_sessions.phone_number).toBe("+5562111");
    expect(JSON.stringify(r)).not.toContain("Ana");
    expect(JSON.stringify(r)).not.toContain("+5562999");
  });

  it("não altera o original (o handler é compartilhado com a sessão)", () => {
    const original = structuredClone(conversa);
    redigirContatoParaModulo(SEM, conversa);
    expect(conversa).toEqual(original);
  });

  it("módulo COM contatos, sessão e outros tokens: vê tudo", () => {
    expect(redigirContatoParaModulo(COM, conversa)).toBe(conversa);
    expect(redigirContatoParaModulo(SESSAO, conversa)).toBe(conversa);
    expect(redigirContatoParaModulo({ actor: { type: "mcp" } }, conversa)).toBe(conversa);
  });

  it("lado seguro: módulo cujo `contatoVisivel` não veio é tratado como sem contatos", () => {
    expect(moduloSemContato({ actor: { type: "module" } })).toBe(true);
    const r = redigirContatoParaModulo({ actor: { type: "module" } }, conversa);
    expect(r.contacts).toEqual({ id: "k1", redacted: true });
  });

  it("lista de contatos aninhada, contato nulo e campos soltos", () => {
    const r = redigirContatoParaModulo(SEM, {
      linhas: [{ contact: { id: "a", name: "X", phone_number: "1" }, contact_name: "X", contact_phone: "1", contacts: null }],
    });
    expect(r.linhas[0]).toEqual({ contact: { id: "a", redacted: true }, contact_name: null, contact_phone: null, contacts: null });
  });

  it("objeto de contato sem id vira null (nada vaza)", () => {
    const r = redigirContatoParaModulo(SEM, { contacts: { name: "Ana" } });
    expect(r.contacts).toBeNull();
  });
});
