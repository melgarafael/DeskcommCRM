import { describe, it, expect } from "vitest";
import { renderTemplate } from "@/lib/automation/template";

const ctx = {
  contact: { name: "Ana" },
  lead: { title: "Pedido X", custom_fields: { cupom: "BF10" } },
};

describe("renderTemplate", () => {
  it("variável simples", () => expect(renderTemplate("Oi {{contact.name}}!", ctx)).toBe("Oi Ana!"));
  it("path aninhado", () =>
    expect(renderTemplate("Use {{lead.custom_fields.cupom}}", ctx)).toBe("Use BF10"));
  it("alias {{nome}} resolve contact.name", () =>
    expect(renderTemplate("Oi {{nome}}", ctx)).toBe("Oi Ana"));
  it("{{nome}} cai no nome do perfil do WhatsApp quando não há nome cadastrado", () => {
    // Contato que chega pelo WhatsApp tem `name` nulo e o pushName em
    // `display_name` — a automação "lead.created" saía "Olá , ..." em produção.
    const doWhatsApp = { contact: { name: null, display_name: "Rafael Melgaço" } };
    expect(renderTemplate("Olá {{nome}},", doWhatsApp)).toBe("Olá Rafael Melgaço,");
    expect(renderTemplate("Olá {{primeiro_nome}},", doWhatsApp)).toBe("Olá Rafael,");
  });
  it("{{nome}} não usa identificador técnico como nome de gente", () =>
    expect(
      renderTemplate("Oi {{nome}}", { contact: { name: null, display_name: "59782320914646@lid" } }),
    ).toBe("Oi "));
  it("variável ausente vira vazio, não '{{...}}' cru", () =>
    expect(renderTemplate("X{{lead.ghost}}Y", ctx)).toBe("XY"));
  it("espaços dentro das chaves tolerados", () =>
    expect(renderTemplate("Oi {{ contact.name }}", ctx)).toBe("Oi Ana"));
  describe("{{campo}} curto para campo personalizado do lead (issue #1993)", () => {
    const comCampos = {
      contact: { name: "Ana" },
      lead: {
        custom_fields: {
          servico: "projeto_customizado",
          interesses: ["a", "b"],
          qtd: 3,
          vazio: "",
        },
      },
    };
    it("resolve o nome do campo que o formulário mandou", () =>
      expect(renderTemplate("Oi {{nome}}, você quer {{servico}}", comCampos)).toBe(
        "Oi Ana, você quer projeto_customizado",
      ));
    it("número e lista saem legíveis", () => {
      expect(renderTemplate("{{qtd}} itens", comCampos)).toBe("3 itens");
      expect(renderTemplate("{{interesses}}", comCampos)).toBe("a, b");
    });
    it("campo que não existe vira vazio, como qualquer variável ausente", () =>
      expect(renderTemplate("X{{fantasma}}Y", comCampos)).toBe("XY"));
    it("o caminho longo continua funcionando", () =>
      expect(renderTemplate("{{lead.custom_fields.servico}}", comCampos)).toBe(
        "projeto_customizado",
      ));
    it("alias e caminho direto GANHAM do campo de mesmo nome (nada que funcionava muda)", () => {
      const colisao = {
        contact: { name: "Ana" },
        lead: { custom_fields: { nome: "Outro", email: "x@y.com" } },
      };
      expect(renderTemplate("{{nome}}", colisao)).toBe("Ana");
      expect(renderTemplate("{{nome}}", { contact: { name: null }, lead: colisao.lead })).toBe("");
    });
    it("sem lead no contexto, não quebra", () =>
      expect(renderTemplate("{{servico}}", { contact: { name: "Ana" } })).toBe(""));
    it("custom_fields que não é objeto é ignorado", () =>
      expect(renderTemplate("{{servico}}", { lead: { custom_fields: ["servico"] } })).toBe(""));
  });
  it("{{primeiro_nome}} é a primeira palavra do nome, como no Inbox (#1616)", () =>
    expect(
      renderTemplate("Olá, {{primeiro_nome}}!", { contact: { name: "  Maria  Souza " } }),
    ).toBe("Olá, Maria!"));
  it("{{primeiro_nome}} sem contato vira vazio, para a lacuna continuar visível", () => {
    expect(renderTemplate("Olá, {{primeiro_nome}}!", {})).toBe("Olá, !");
    expect(renderTemplate("{{primeiro_nome}}", { contact: { name: null } })).toBe("");
  });
});

describe('renderTemplate: texto de reserva {{variavel|"reserva"}}', () => {
  const semNome = { contact: { name: null }, lead: { custom_fields: { cupom: "" } } };

  it("sem o dado, sai a reserva", () => {
    expect(renderTemplate('Oi {{primeiro_nome|"aluno"}}!', semNome)).toBe("Oi aluno!");
    expect(renderTemplate('Oi {{nome|"aluno"}}!', semNome)).toBe("Oi aluno!");
    expect(renderTemplate('Use {{cupom|"sem cupom"}}', semNome)).toBe("Use sem cupom");
    expect(renderTemplate('{{lead.ghost|"nada"}}', semNome)).toBe("nada");
  });

  it("com o dado, a reserva é ignorada", () => {
    expect(renderTemplate('Oi {{primeiro_nome|"aluno"}}!', ctx)).toBe("Oi Ana!");
    expect(renderTemplate('Use {{cupom|"sem cupom"}}', ctx)).toBe("Use BF10");
  });

  it("aceita aspas tipográficas e espaços", () => {
    expect(renderTemplate("Oi {{ nome | “aluno” }}", semNome)).toBe("Oi aluno");
  });

  it("a reserva é texto de quem escreveu: não passa pelo formatarValor", () => {
    const escapar = (v: string) => v.replace(/&/g, "&amp;");
    expect(renderTemplate('{{nome|"R&D"}}', semNome, escapar)).toBe("R&D");
    expect(renderTemplate("{{nome}}", { contact: { name: "R&D" } }, escapar)).toBe("R&amp;D");
  });

  it("reserva torta não casa e fica como escrita", () => {
    expect(renderTemplate('{{nome|"a{b"}}', semNome)).toBe('{{nome|"a{b"}}');
    expect(renderTemplate("{{nome|aluno}}", semNome)).toBe("{{nome|aluno}}");
  });

  it("o nome da agenda continua só da equipe, mesmo com reserva", () => {
    expect(renderTemplate('{{contact.address_book_name|"x"}}', { contact: { address_book_name: "Fulano Interno" } })).toBe("");
  });
});
