import { describe, expect, it } from "vitest";

import { anexarNomeDoContato } from "@/lib/kanban/dados-do-contato";
import type { Lead } from "@/lib/types/leads";

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

// Resposta de rota é JSON arbitrário: o teste lê campos que o tipo de entrada não declara.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const red = (v: unknown): any => redigirContatoParaModulo(SEM, v);

describe("redigirContatoParaModulo: texto livre", () => {
  const contato = { id: "k1", name: "João Silva", display_name: "João", phone_number: "+55 11 98765-4321", email: "Joao.Silva@Exemplo.com" };
  const negocio = (title: string) => ({ id: "n1", contact_id: "k1", title, contacts: contato });

  it("o nome inteiro, só o primeiro nome, acento diferente, telefone formatado e e-mail em maiúscula viram [contato]", () => {
    const titulos = [
      "Proposta para João Silva",
      "Retorno do Joao",
      "ligar para (11) 98765-4321",
      "ligar para +55 11 987654321",
      "mandar para JOAO.SILVA@EXEMPLO.COM hoje",
    ];
    for (const t of titulos) {
      const r = red(negocio(t));
      expect(r.title, t).toContain("[contato]");
      expect(r.title, t).not.toMatch(/Jo[ãa]o|98765|987654321|exemplo/i);
      expect(r.text_redacted, t).toBe(true);
    }
    expect(red(negocio("Proposta para João Silva")).title).toBe("Proposta para [contato]");
    expect(red(negocio("ligar para (11) 98765-4321")).title).toBe("ligar para [contato]");
  });

  it("texto sem identificador do contato não é tocado e não ganha text_redacted", () => {
    const r = red(negocio("Proposta comercial"));
    expect(r.title).toBe("Proposta comercial");
    expect(r).not.toHaveProperty("text_redacted");
  });

  it("filho herda os identificadores do registro (texto dentro de lista aninhada)", () => {
    const r = red({ ...negocio("x"), notas: [{ texto: "falei com Joao" }] });
    expect(r.notas[0]!.texto).toBe("falei com [contato]");
    expect(r.notas[0]!.text_redacted).toBe(true);
  });

  it("quadro com 2 negócios de contatos diferentes: o nome do contato A no título do B NÃO é trocado", () => {
    // Formato REAL do quadro: o lead vem de `crm_leads` SEM nome; a rota lê o contato e anexa o nome.
    const leads = [
      { id: "a", contact_id: "ka", title: "Reforma da Maria Souza" },
      { id: "b", contact_id: "kb", title: "Contrato da Maria Souza com Pedro Alves" },
    ] as unknown as Lead[];
    const anexados = anexarNomeDoContato(leads, [
      { id: "ka", name: "Maria Souza" },
      { id: "kb", name: "Pedro Alves" },
    ]);
    const r = red({ leads: anexados });
    expect(r.leads[0]!.title).toBe("Reforma da [contato]");
    expect(r.leads[0]!.text_redacted).toBe(true);
    // do contato B saiu só o nome do B; "Maria Souza" (contato do irmão A) fica
    expect(r.leads[1]!.title).toBe("Contrato da Maria Souza com [contato]");
    // o nome anexado só serve ao filtro: não sai na resposta
    expect(r.leads[0]!.contact_name).toBeNull();
  });

  it("quadro no formato real: título 'Proposta João Silva', contato com `name`, vira [contato]", () => {
    const leads = [{ id: "a", contact_id: "k", title: "Proposta João Silva" }] as unknown as Lead[];
    const r = red({ leads: anexarNomeDoContato(leads, [{ id: "k", name: "João Silva", display_name: "João" }]) });
    expect(r.leads[0]!.title).toBe("Proposta [contato]");
    expect(JSON.stringify(r)).not.toContain("Silva");
  });

  it("sem anexar o nome (sessão ou módulo com contatos), o lead não ganha campo nenhum", () => {
    const leads = [{ id: "a", contact_id: "k", title: "Proposta João Silva" }] as unknown as Lead[];
    expect(anexarNomeDoContato(leads, [])).toBe(leads);
    expect(Object.keys(anexarNomeDoContato(leads, [{ id: "k", name: null }])[0]!)).toEqual(["id", "contact_id", "title"]);
  });

  it("texto enorme de separadores não trava (sem backtracking exponencial) e volta sem mudança", () => {
    const texto = " .-".repeat(33_334) + "fim";
    const r = red({ id: "n", title: texto, contacts: { id: "k", phone_number: "+55 11 98765-4321" } });
    expect(r.title).toBe(texto);
    expect(r).not.toHaveProperty("text_redacted");
  });

  it("parte do nome com menos de 3 letras não é trocada; fronteira de palavra (Ana não sai de Banana)", () => {
    const r = red({
      id: "n",
      title: "Li e Banana e Ana",
      contacts: { id: "k", name: "Ana Li" },
    });
    expect(r.title).toBe("Li e Banana e [contato]");
  });

  it("módulo COM contatos e sessão: resposta idêntica à original", () => {
    const n = negocio("Proposta para João Silva");
    expect(redigirContatoParaModulo(COM, n)).toBe(n);
    expect(redigirContatoParaModulo(SESSAO, n)).toBe(n);
  });

  it("o original não é alterado pelo filtro de texto", () => {
    const n = negocio("Proposta para João Silva");
    const copia = structuredClone(n);
    red(n);
    expect(n).toEqual(copia);
  });

  it("limite conhecido: apelido e nome de outra pessoa passam", () => {
    const r = red({ id: "n", title: "Cida pediu; fale com Carlos", contacts: { id: "k", name: "Aparecida Lima" } });
    expect(r.title).toBe("Cida pediu; fale com Carlos");
  });
});
