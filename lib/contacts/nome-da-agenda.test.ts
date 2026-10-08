import { describe, expect, it } from "vitest";

import {
  consultarNomeDaAgenda,
  idsParaConsultarAgenda,
  nomeGravavel,
  patchDoNome,
} from "./nome-da-agenda";

describe("nome gravável", () => {
  it("aceita o nome salvo na agenda", () => {
    expect(nomeGravavel("  Vânia Messias ")).toBe("Vânia Messias");
  });

  it("recusa telefone, id opaco e o rótulo técnico antigo", () => {
    expect(nomeGravavel("+5562984480025")).toBeNull();
    expect(nomeGravavel("250302204792918@lid")).toBeNull();
    expect(nomeGravavel("Contato 543134")).toBeNull();
    expect(nomeGravavel("")).toBeNull();
  });
});

describe("ids para consultar a agenda", () => {
  it("pergunta as duas grafias do celular brasileiro e só depois o id opaco", () => {
    expect(idsParaConsultarAgenda("+5562984480025", "250302204792918")).toEqual([
      "5562984480025@c.us",
      "556284480025@c.us",
      "250302204792918@lid",
    ]);
  });

  it("sem telefone ainda pergunta pelo id opaco", () => {
    expect(idsParaConsultarAgenda(null, "250302204792918")).toEqual(["250302204792918@lid"]);
  });
});

describe("consulta", () => {
  it("a grafia sem o nono dígito é a que tem o nome salvo", async () => {
    const pedidos: string[] = [];
    const achado = await consultarNomeDaAgenda(async (id) => {
      pedidos.push(id);
      if (id === "556284480025@c.us") {
        return { name: "Cliente da obra", pushname: null, shortName: null };
      }
      return { name: null, pushname: null, shortName: null };
    }, "+5562984480025", null);

    expect(achado.agenda).toBe("Cliente da obra");
    expect(achado.respondeu).toBe(true);
    expect(pedidos[0]).toBe("5562984480025@c.us");
    expect(pedidos).toContain("556284480025@c.us");
  });

  it("canal calado não vira 'não tem nome'", async () => {
    const achado = await consultarNomeDaAgenda(async () => null, "+5562984480025", null);
    expect(achado.respondeu).toBe(false);
    expect(achado.agenda).toBeNull();
  });
});

describe("o que gravar", () => {
  it("o nome da agenda vai para o campo da equipe, nunca para name nem display_name", () => {
    expect(
      patchDoNome(
        { name: null, display_name: "Zé" },
        { agenda: "José Arlindo", perfil: "Zé" },
      ),
    ).toEqual({ address_book_name: "José Arlindo" });
  });

  it("sem agenda, o apelido só preenche quando a tela não tem nome", () => {
    expect(patchDoNome({ name: null, display_name: null }, { agenda: null, perfil: "Jose Nunes" })).toEqual({
      display_name: "Jose Nunes",
    });
    expect(patchDoNome({ name: null, display_name: "Jose Nunes" }, { agenda: null, perfil: "Outro" })).toEqual(
      {},
    );
  });

  it("nome já digitado no CRM não é substituído", () => {
    expect(
      patchDoNome({ name: "Nome da ficha", display_name: null }, { agenda: "Agenda", perfil: "Perfil" }),
    ).toEqual({});
  });
});
