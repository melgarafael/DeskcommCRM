import { describe, expect, it } from "vitest";

import { EXTENSION_PERMISSIONS } from "./capacidades";
import {
  ehAreaSensivel,
  fraseDaPermissaoDeArea,
  nomeDaPorta,
  portasLegiveis,
  type PermissaoDeArea,
} from "./portas-legiveis";

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

describe("frases do consentimento por área (módulo conectado, F3)", () => {
  const permissoesDeArea = EXTENSION_PERMISSIONS.filter((p): p is PermissaoDeArea =>
    p.startsWith("area."),
  );

  it("as 24 permissões de área têm frase própria, não vazia e diferente entre si", () => {
    expect(permissoesDeArea).toHaveLength(24);
    const frases = permissoesDeArea.map((p) => fraseDaPermissaoDeArea(p));
    expect(frases.every((frase) => frase.length > 10)).toBe(true);
    expect(new Set(frases).size).toBe(24);
  });

  it("só configuração, agentes de IA e financeiro são sensíveis", () => {
    const sensiveis = permissoesDeArea.filter(ehAreaSensivel).sort();
    expect(sensiveis).toEqual([
      "area.agentes_ia.escrita",
      "area.agentes_ia.leitura",
      "area.configuracao.escrita",
      "area.configuracao.leitura",
      "area.financeiro.escrita",
      "area.financeiro.leitura",
    ]);
    // Tarefas e etiquetas NÃO são sensíveis: não mexem no dinheiro nem no funcionamento da organização.
    expect(ehAreaSensivel("area.tarefas.escrita")).toBe(false);
    expect(ehAreaSensivel("area.etiquetas.leitura")).toBe(false);
  });

  it("as frases das três áreas novas dizem o que o módulo passa a poder fazer", () => {
    expect(fraseDaPermissaoDeArea("area.tarefas.escrita")).toBe("Ver e mudar tarefas e demandas.");
    expect(fraseDaPermissaoDeArea("area.etiquetas.leitura")).toBe("Ver as etiquetas.");
    expect(fraseDaPermissaoDeArea("area.financeiro.escrita")).toBe(
      "Ver e mudar comandas, fidelidade e lançamentos financeiros.",
    );
  });

  it("a frase da lista nomeia as áreas novas em Lê/Altera", () => {
    expect(portasLegiveis(["area.financeiro.leitura", "area.tarefas.leitura", "area.tarefas.escrita"])).toBe(
      "Lê Financeiro e Tarefas. Altera Tarefas.",
    );
  });

  it("traduz cada frase pelo tradutor recebido (literais cobertos pelo dicionário)", () => {
    const marcada = fraseDaPermissaoDeArea("area.agenda.leitura", (texto) => `[${texto}]`);
    expect(marcada).toBe("[Ver a agenda e os agendamentos.]");
  });
});
