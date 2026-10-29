import { describe, expect, it } from "vitest";

import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  nomeDoContatoParaComparar,
  palavrasDoNome,
  parDeContatos,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { fichaVivaDe } from "@/lib/contacts/dispensar-par";

/**
 * O repetido pelo NOME (Spec 31, PR A). O nome sugere, não prova: a régua é de
 * raridade (a palavra do nicho não conta) e de nome inteiro contido (≥ 6 letras).
 * Cada caso diz, no comentário, qual sabotagem o deixa vermelho.
 */
function contato(id: string, campos: Partial<ContatoParaDeduplicar> = {}): ContatoParaDeduplicar {
  return {
    id,
    name: null,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    ...campos,
  };
}

describe("nome parecido: palavras raras", () => {
  it("1. dois nomes que dividem 2 palavras raras formam 1 par", () => {
    // Sabotagem: exigir 3 palavras em comum (ou nenhuma régua) deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia" }),
      contato("b", { name: "Santos Odontologia Clínica Avançada" }),
    ]);
    expect(pares).toHaveLength(1);
    expect(pares[0]!.motivos).toEqual(["nome_parecido"]);
    expect(pares[0]!.contatos.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("2. a palavra do nicho, presente em 5 fichas, não forma par", () => {
    // Sabotagem: a régua "qualquer palavra em comum" deixa este caso vermelho — com 5
    // fichas "Odontologia" a palavra não é rara, e ninguém deveria ser sugerido.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Alfa Odontologia" }),
      contato("b", { name: "Beta Odontologia" }),
      contato("c", { name: "Gama Odontologia" }),
      contato("d", { name: "Delta Odontologia" }),
      contato("e", { name: "Épsilon Odontologia" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("nome parecido: nome inteiro contido", () => {
  it("3. 'Guarnieri Materiais' dentro de 'Comercial - Guarnieri Materiais' forma 1 par", () => {
    // Sabotagem: comparar sem a borda de espaço (" nome ") ou sem o caminho de nome
    // inteiro deixa este caso sem o par pelo critério (b).
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri Materiais" }),
      contato("b", { name: "Comercial - Guarnieri Materiais" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("4. nome contido curto ('Ana' em 'Ana Paula Doces') não forma par", () => {
    // Sabotagem: tirar o mínimo de 6 letras do critério (b) faz 'ana' casar e deixa vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Ana" }),
      contato("b", { name: "Ana Paula Doces" }),
    ]);
    expect(pares).toEqual([]);
  });

  it("8. caixa e acento não impedem o par: 'JOSÉ CONFEITARIA DOCE' e 'jose confeitaria doce lar'", () => {
    // Sabotagem: não normalizar acento e caixa deixa 'josé' e 'jose' diferentes e vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "JOSÉ CONFEITARIA DOCE" }),
      contato("b", { name: "jose confeitaria doce lar" }),
    ]);
    expect(pares).toHaveLength(1);
  });
});

describe("nome parecido: o nome que a varredura lê", () => {
  it("5. ficha com name nulo e o nome só em display_name entra no par", () => {
    // Sabotagem: ler só `name` faz a ficha A virar sem palavras e deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: null, display_name: "Confeitaria Doce Lar" }),
      contato("b", { name: "Confeitaria Doce Lar Centro" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("5b. ficha só com o nome da agenda do celular (address_book_name) também entra", () => {
    // Sabotagem: não ler `address_book_name` em `nomeDoContatoParaComparar` deixa vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: null, display_name: null, address_book_name: "Mercado Central Norte" }),
      contato("b", { name: "Mercado Central Norte Filial" }),
    ]);
    expect(pares).toHaveLength(1);
    expect(nomeDoContatoParaComparar({ name: "  ", display_name: null, address_book_name: "Agenda" })).toBe("Agenda");
  });
});

describe("nome parecido: não se mistura com o grupo forte", () => {
  it("6. mesmo telefone (com e sem o nono dígito) e nomes parecidos: não é par de nome, e o forte segue", () => {
    // Sabotagem: não excluir quem já é forte faria este par aparecer como nome também.
    const a = contato("a", { name: "Clínica Santos Odontologia", phone_number: "+553198966398" });
    const b = contato("b", { name: "Santos Odontologia Clínica", phone_number: "+5531998966398" });

    expect(encontrarParecidosPorNome([a, b])).toEqual([]);
    const fortes = encontrarContatosDuplicados([a, b]);
    expect(fortes).toHaveLength(1);
    expect(fortes[0]!.motivos).toEqual(["telefone"]);
  });
});

describe("nome parecido: dispensa", () => {
  it("7. par dispensado não aparece, nem com a ordem dos ids invertida", () => {
    // Sabotagem: ignorar `dispensados` deixa o par na lista; trocar parDeContatos por
    // uma ordem que depende da entrada faria o par invertido escapar e deixaria vermelho.
    const a = contato("aaa", { name: "Clínica Santos Odontologia" });
    const b = contato("bbb", { name: "Santos Odontologia Clínica" });
    expect(parDeContatos("bbb", "aaa")).toBe(parDeContatos("aaa", "bbb"));

    const dispensados = new Set([parDeContatos("bbb", "aaa")]);
    expect(encontrarParecidosPorNome([a, b], { dispensados })).toEqual([]);
    expect(encontrarParecidosPorNome([a, b])).toHaveLength(1);
  });
});

describe("nome parecido: quem não é sugerido", () => {
  it("9. anonimizada ou mesclada não entra", () => {
    // Sabotagem: não filtrar `elegivelParaMesclagem` faz a lápide e a anonimizada entrarem.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia" }),
      contato("b", { name: "Santos Odontologia Clínica", is_anonymized: true }),
      contato("c", { name: "Santos Odontologia Clínica Avançada", is_merged_into: "a" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("palavrasDoNome", () => {
  it("tira acento, pontuação e palavra de ligação, sem repetir", () => {
    expect(palavrasDoNome("Clínica - Santos DA Santos, Dr.")).toEqual(["clinica", "santos"]);
  });
});

describe("fichaVivaDe (a dispensa acompanha a fusão)", () => {
  it("10. segue a cadeia de fusões até a ficha viva", () => {
    // A mesclada em B, B mesclada em C: quem era A vira C.
    const mapa = new Map<string, string | null>([
      ["A", "B"],
      ["B", "C"],
      ["C", null],
    ]);
    expect(fichaVivaDe("A", mapa)).toBe("C");
  });

  it("10b. ciclo não gira para sempre: devolve um id visto", () => {
    const mapa = new Map<string, string | null>([
      ["X", "Y"],
      ["Y", "X"],
    ]);
    expect(["X", "Y"]).toContain(fichaVivaDe("X", mapa));
  });

  it("10c. mais de 5 saltos para na 5ª ficha, sem laço", () => {
    const mapa = new Map<string, string | null>();
    for (let i = 1; i <= 8; i++) mapa.set(String(i), String(i + 1));
    expect(fichaVivaDe("1", mapa)).toBe("6");
  });
});

describe("nome parecido: nome igual", () => {
  it("11. nome igual curto ('João' e 'João') não forma par; igual com 6 letras ou mais forma", () => {
    // Sabotagem: aceitar nome igual de qualquer tamanho faz o par 'joao' aparecer e deixa vermelho.
    const curtos = encontrarParecidosPorNome([
      contato("a", { name: "João" }),
      contato("b", { name: "joao" }),
    ]);
    expect(curtos).toEqual([]);
    const longos = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri" }),
      contato("b", { name: "GUARNIERI" }),
    ]);
    expect(longos).toHaveLength(1);
  });
});

describe("nome parecido: só o critério do nome contido", () => {
  it("12. 'Guarnieri' dentro de 'Comercial Guarnieri' forma par mesmo com 'comercial' comum", () => {
    // Só UMA palavra rara em comum ('guarnieri'): o critério (a) não pega o par, e
    // 'comercial' aparece em 6 fichas. Sabotagem: tirar o critério (b) — ou a borda
    // de espaço que o delimita — deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri" }),
      contato("b", { name: "Comercial Guarnieri" }),
      contato("c", { name: "Comercial Alfa" }),
      contato("d", { name: "Comercial Beta" }),
      contato("e", { name: "Comercial Gama" }),
      contato("f", { name: "Comercial Delta" }),
    ]);
    expect(pares.map((p) => p.contatos.map((c) => c.id).sort())).toEqual([["a", "b"]]);
  });
});
