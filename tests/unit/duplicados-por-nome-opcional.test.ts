/**
 * #4138 — a sugestão de duplicado pelo NOME é opção da empresa, desligada por
 * padrão, e o par com identidade forte CONTRADITÓRIA não é sugerido.
 *
 * A régua de sugestão em si (palavra rara, nome contido, dispensa) já é provada
 * em `contatos-duplicados-nome-parecido.test.ts` e não é repetida aqui. O que
 * este arquivo fixa é o que a #4138 acrescenta:
 *
 *   - a opção nasce DESLIGADA, e só o booleano `true` liga;
 *   - com ela desligada, a varredura por nome não roda (a rota é a dona disso, e
 *     está provado em `app/api/v1/contacts/duplicates/route.test.ts`);
 *   - dois CPFs diferentes NÃO formam par: é a régua
 *     que separa sugestão útil de ruído;
 *   - telefone diferente continua formando par (fixo + celular, B1 da issue);
 *   - acento, caixa e espaço sobrando não impedem o par.
 */
import { describe, expect, it } from "vitest";

import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  identidadeForteConflita,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { duplicadosPorNomeLigado } from "@/lib/schemas/settings";

function contato(id: string, campos: Partial<ContatoParaDeduplicar> = {}): ContatoParaDeduplicar {
  return {
    id,
    name: null,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    cpf_hash: null,
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    ...campos,
  };
}

describe("#4138 · a opção da empresa", () => {
  it("1. ausente, false, a string \"true\" e lixo são DESLIGADO; só o booleano true liga", () => {
    // Sabotagem: trocar a régua por `Boolean(...)` ligaria a string "true" e o 1,
    // e a tela passaria a sugerir nome em organização que nunca pediu.
    expect(duplicadosPorNomeLigado(undefined)).toBe(false);
    expect(duplicadosPorNomeLigado({})).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: {} })).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: { duplicados_por_nome: false } })).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: { duplicados_por_nome: "true" } })).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: { duplicados_por_nome: 1 } })).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: [] })).toBe(false);
    expect(duplicadosPorNomeLigado({ crm: { duplicados_por_nome: true } })).toBe(true);
  });

  it("2. a opção convive com as outras regras de CRM sem apagar nenhuma", () => {
    // Sabotagem: trocar a mescla por um objeto novo (em vez de espalhar o `crm`)
    // apagaria `cliente_pela_agenda` de quem ligou a sugestão por nome.
    const settings = {
      crm: { cliente_pela_agenda: true, duplicados_por_nome: true, pos_venda_dias: 7 },
    };
    expect(duplicadosPorNomeLigado(settings)).toBe(true);
    expect(duplicadosPorNomeLigado({ crm: { ...settings.crm, duplicados_por_nome: false } })).toBe(false);
  });
});

describe("#4138 · identidade forte que se contradiz", () => {
  it("3. ⭐ telefone diferente nos dois lados: o nome AINDA forma par (fixo e celular)", () => {
    // O B1 da issue: a mesma empresa com dois números — comercial e WhatsApp, ou
    // fixo e celular. Número diferente NÃO é contradição; a regra "um número, uma
    // ficha" governa o agrupamento forte, não a sugestão por nome.
    // Sabotagem: fazer `identidadeForteConflita` olhar telefone derruba este caso.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia", phone_number: "+553****0010" }),
      contato("b", { name: "Santos Odontologia Clínica", phone_number: "+553****0020" }),
    ]);
    expect(pares).toHaveLength(1);
    expect(
      identidadeForteConflita(
        { phone_number: "+553****0010", cpf_hash: null },
        { phone_number: "+553****0020", cpf_hash: null },
      ),
    ).toBe(false);
  });

  it("4. ⭐ CPF diferente nos dois lados: dois documentos, dois cadastros — não sugere", () => {
    // Sabotagem: comparar só o telefone deixa o par de mesma pessoa? Não — dois
    // hashes diferentes são duas pessoas, e o par aparece sem esta régua.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia", cpf_hash: "hash-do-cpf-de-a" }),
      contato("b", { name: "Santos Odontologia Clínica", cpf_hash: "hash-do-cpf-de-b" }),
    ]);
    expect(pares).toEqual([]);
  });

  it("5. o par ÚTIL continua: nome parecido e só um lado com telefone (ficha do WhatsApp)", () => {
    // É o caso B1/B7 da spec 31: a segunda ficha nasceu do WhatsApp e não tem
    // número. Sem esta garantia, a régua de conflito mataria a sugestão inteira.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri Materiais", phone_number: "+5531911110010" }),
      contato("b", { name: "Comercial - Guarnieri Materiais" }),
    ]);
    expect(pares).toHaveLength(1);
    expect(pares[0]!.contatos.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("6. o par ÚTIL continua com CPF de um lado só", () => {
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri Materiais", cpf_hash: "hash-de-a" }),
      contato("b", { name: "Comercial - Guarnieri Materiais" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("7. não afrouxa o motivo FORTE: mesmo telefone segue no grupo forte, e não vira par de nome", () => {
    // Sabotagem: fazer `identidadeForteConflita` devolver `true` para telefone
    // IGUAL (em vez de diferente) apagaria o par forte da tela — a regressão que
    // a entrega não pode causar.
    const a = contato("a", { name: "Clínica Santos Odontologia", phone_number: "+5531911116398" });
    const b = contato("b", { name: "Santos Odontologia Clínica", phone_number: "+5531911116398" });
    expect(identidadeForteConflita(a, b)).toBe(false);
    expect(encontrarParecidosPorNome([a, b])).toEqual([]);
    const fortes = encontrarContatosDuplicados([a, b]);
    expect(fortes).toHaveLength(1);
    expect(fortes[0]!.motivos).toEqual(["telefone"]);
  });
});

describe("#4138 · normalização do nome", () => {
  it("8. acento, caixa e espaço sobrando não impedem o par", () => {
    // Sabotagem: comparar o nome cru deixa "JOSÉ" ≠ "jose" e "  Clínica   " com
    // palavras vazias — o par some.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "  JOSÉ   Confeitaria Doce " }),
      contato("b", { name: "jose confeitaria doce lar" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("9. espaço a mais no meio e no fim não cria palavra falsa", () => {
    // Uma palavra vazia ('') não pode entrar no índice e casar com toda ficha
    // que também tenha espaço sobrando.
    expect(
      encontrarParecidosPorNome([
        contato("a", { name: "Padaria   Central    Norte" }),
        contato("b", { name: "Padaria Central Norte " }),
      ]),
    ).toHaveLength(1);
  });
});
