/**
 * A RÉGUA DO NOME REPETIDO (#3952) — o que ela aceita e o que ela RECUSA.
 *
 * A recusa certa é fácil de provar; o que quebra em produção é a recusa ERRADA:
 * um `23505` de outro índice traduzido como "nome repetido" manda a pessoa
 * trocar um nome que estava livre e esconde um defeito de verdade. Por isso os
 * casos "não é esta recusa" têm tanto peso aqui quanto o positivo.
 */
import { describe, expect, it } from "vitest";

import {
  CODIGO_NOME_DE_AGENTE_EM_USO,
  INDICE_NOME_DE_AGENTE,
  NOME_DE_AGENTE_EM_USO,
  ehNomeDeAgenteRepetido,
} from "./nome-repetido";

/** O erro que o PostgREST devolve quando o índice composto recusa o insert. */
const DUPLICADO = {
  code: "23505",
  message: `duplicate key value violates unique constraint "${INDICE_NOME_DE_AGENTE}"`,
  details:
    "Key (organization_id, name)=(11111111-1111-4111-8111-111111111111, Recepção) already exists.",
  hint: null,
};

describe("ehNomeDeAgenteRepetido", () => {
  it("reconhece o índice pelo nome na mensagem do banco", () => {
    expect(ehNomeDeAgenteRepetido(DUPLICADO)).toBe(true);
  });

  it("reconhece pelo `details` quando a mensagem perde o nome do índice", () => {
    expect(
      ehNomeDeAgenteRepetido({
        code: "23505",
        message: "duplicate key value violates unique constraint",
        details: "Key (organization_id, name)=(org, Recepção) already exists.",
      }),
    ).toBe(true);
    expect(
      ehNomeDeAgenteRepetido({
        code: "23505",
        message: "",
        details: "Key (name, organization_id)=(Recepção, org) already exists.",
      }),
    ).toBe(true);
  });

  it("NÃO reconhece outro índice único da mesma tabela", () => {
    expect(
      ehNomeDeAgenteRepetido({
        code: "23505",
        message: 'duplicate key value violates unique constraint "ai_agents_org_default_unique"',
        details: "Key (organization_id)=(org) already exists.",
      }),
    ).toBe(false);
  });

  it("NÃO reconhece um 23505 de outra tabela, nem um índice de coluna única", () => {
    expect(
      ehNomeDeAgenteRepetido({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "ai_agent_versions_unique_number"',
        details: "Key (agent_id, version_number)=(a, 1) already exists.",
      }),
    ).toBe(false);
    // `Key (organization_id)=` é índice de UMA coluna: não é o par do nome.
    expect(
      ehNomeDeAgenteRepetido({
        code: "23505",
        message: "duplicate key value violates unique constraint",
        details: "Key (organization_id)=(org) already exists.",
      }),
    ).toBe(false);
  });

  it("NÃO reconhece erro que não é unicidade", () => {
    expect(
      ehNomeDeAgenteRepetido({
        code: "23503",
        message:
          'insert or update on table "ai_agents" violates foreign key constraint "ai_agents_created_by_fkey"',
        details: 'Key (created_by)=(usuario-1) is not present in table "users".',
      }),
    ).toBe(false);
    expect(ehNomeDeAgenteRepetido({ code: "42501", message: "permission denied" })).toBe(false);
  });

  it("não estoura com erro que não é objeto (o `catch` da rota pode trazer qualquer coisa)", () => {
    for (const entrada of [null, undefined, "23505", 42, new Error("boom")]) {
      expect(() => ehNomeDeAgenteRepetido(entrada)).not.toThrow();
      expect(ehNomeDeAgenteRepetido(entrada)).toBe(false);
    }
  });

  it("o código e a frase são os mesmos que a rota devolve", () => {
    // Contrato de wire: mudar aqui sem mudar o consumidor quebra a tela.
    expect(CODIGO_NOME_DE_AGENTE_EM_USO).toBe("agent_name_taken");
    expect(NOME_DE_AGENTE_EM_USO).toBe("Já existe um agente com esse nome.");
  });
});
