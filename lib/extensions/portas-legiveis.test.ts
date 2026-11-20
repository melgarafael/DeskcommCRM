import { describe, expect, it } from "vitest";

import { EXTENSION_PERMISSIONS } from "./capacidades";
import { nomeDaPorta, portasLegiveis } from "./portas-legiveis";

/**
 * A LISTA DE PORTAS É A ÚNICA COISA QUE A PESSOA TEM PARA DECIDIR — E ELA PRECISA ESTAR INTEIRA.
 *
 * O defeito que este arquivo previne já existiu: a tela derivava uma frase de
 * `permissions.includes("navigation.tasks")`. Com uma permissão só, era a verdade inteira.
 * Com a lista fechada, a mesma frase passou a esconder tudo que não fosse Tarefas — e uma
 * extensão que abre Conversas e Contatos, sem incluir Tarefas, caía no ramo "não recebe
 * acesso aos dados do CRM", que é o oposto do que ela faz.
 */
describe("frase das permissões de área (módulo conectado, F1)", () => {
  it("só leitura de contatos vira 'Lê Contatos.' e não diz que não lê", () => {
    const frase = portasLegiveis(["area.contatos.leitura"]);
    expect(frase).toBe("Lê Contatos.");
    expect(frase).not.toContain("não lê seus dados");
  });

  it("leitura de contatos e agenda com escrita de agenda, na ordem que o código produz", () => {
    const frase = portasLegiveis([
      "area.contatos.leitura",
      "area.agenda.leitura",
      "area.agenda.escrita",
    ]);
    expect(frase).toBe("Lê Agenda e Contatos. Altera Agenda.");
    expect(frase).not.toContain("não lê seus dados");
  });

  it("a ordem da lista de entrada não muda a frase", () => {
    expect(
      portasLegiveis(["area.agenda.escrita", "area.contatos.leitura", "area.agenda.leitura"]),
    ).toBe("Lê Agenda e Contatos. Altera Agenda.");
  });

  it("áreas junto com portas de navegação: abre primeiro, depois lê e altera", () => {
    const frase = portasLegiveis(["navigation.inbox", "area.contatos.leitura"]);
    expect(frase).toBe("Abre Conversas. Lê Contatos.");
    expect(frase).not.toContain("não lê seus dados");
  });
});

describe("frases sem área continuam idênticas às de antes", () => {
  it("uma porta de navegação mantém o texto exato com o limite", () => {
    expect(portasLegiveis(["navigation.tasks"])).toBe("Abre Tarefas; não lê seus dados.");
  });

  it("lista vazia mantém o texto exato", () => {
    expect(portasLegiveis([])).toBe("Não abre nenhuma tela e não lê seus dados.");
  });
});

describe("as portas que a tela mostra", () => {
  it("toda permissão do vocabulário tem nome legível — nenhuma aparece como código", () => {
    for (const permissao of EXTENSION_PERMISSIONS) {
      const nome = nomeDaPorta(permissao);
      expect(nome, `${permissao} sem nome`).toBeTruthy();
      expect(nome, `${permissao} vazou o valor técnico para a tela`).not.toContain("navigation.");
    }
  });

  it("cita TODAS as portas, não só a primeira", () => {
    const frase = portasLegiveis(["navigation.inbox", "navigation.contacts"]);
    expect(frase).toContain("Conversas");
    expect(frase).toContain("Contatos");
  });

  it("uma extensão sem Tarefas não é descrita como se não abrisse nada", () => {
    // O ramo exato do defeito anterior: sem `navigation.tasks`, a frase dizia
    // "Não recebe acesso aos dados do CRM" para uma extensão que abre duas telas.
    const frase = portasLegiveis(["navigation.inbox", "navigation.agenda"]);
    expect(frase).not.toContain("Não recebe acesso");
    expect(frase).toContain("Conversas");
    expect(frase).toContain("Agenda");
  });

  it("diz o limite junto com o alcance — abrir e ler são coisas diferentes", () => {
    expect(portasLegiveis(["navigation.tasks"])).toContain("não lê seus dados");
  });

  it("a ordem é estável: a mesma lista, em qualquer ordem, produz a mesma frase", () => {
    expect(portasLegiveis(["navigation.inbox", "navigation.agenda"])).toBe(
      portasLegiveis(["navigation.agenda", "navigation.inbox"]),
    );
  });

  it("lista vazia é dita como vazia, sem inventar alcance", () => {
    expect(portasLegiveis([])).toContain("Não abre nenhuma tela");
  });
});
