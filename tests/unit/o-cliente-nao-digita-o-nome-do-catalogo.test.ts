import { describe, expect, it } from "vitest";

import { buscarComRelaxamento, ordenarPorRelevancia, pontuar, tokenizar } from "@/lib/catalogo/busca";

/**
 * O CLIENTE NÃO DIGITA O NOME DO CATÁLOGO.
 *
 * ═══ O defeito que esta busca existe para não ter ═══════════════════════════
 *
 * A ferramenta antiga fazia `ilike '%termo%'` no título. Medido num corpus de
 * 20 mil títulos de importados, contra o que a pessoa escreve de verdade:
 *
 *     ilike '%ifone 15%'              -> 0 linhas
 *     ilike '%perfume 212 masculino%' -> 0 linhas
 *
 * E o trigrama da frase inteira não salva: "ifone 15" contra
 * "iphone 15 pro 256gb titanio natural" dá 0,154 de similaridade, abaixo do
 * limiar padrão, porque a métrica pune diferença de tamanho.
 *
 * ═══ O caso que decide o desenho ════════════════════════════════════════════
 *
 * "iPhone 15 Pro 256GB" e "iPhone 15 Pro 128GB" são quase idênticos como texto.
 * NENHUM limiar de similaridade separa os dois — e é exatamente aí que o preço
 * sai errado, que é o erro que não se pode cometer com um cliente.
 *
 * Por isso o número não pontua: ele ELIMINA. Quem pede 128 não pode ver o 256
 * na lista, nem em segundo lugar.
 */

const CATALOGO = [
  { codigo: "IP15-128-PRE", nome: "iPhone 15 128GB Preto", marca: "Apple", categoria: "Celular" },
  { codigo: "IP15P-256-TIT", nome: "iPhone 15 Pro 256GB Titânio", marca: "Apple", categoria: "Celular" },
  { codigo: "IP15PM-256-TIT", nome: "iPhone 15 Pro Max 256GB Titânio", marca: "Apple", categoria: "Celular" },
  { codigo: "MBA-M3-256", nome: "MacBook Air M3 256GB", marca: "Apple", categoria: "Notebook" },
  { codigo: "PERF-212-VIP", nome: "212 VIP Men 100ml", marca: "Carolina Herrera", categoria: "Perfume" },
  { codigo: "PERF-212-SEXY", nome: "212 Sexy Men 100ml", marca: "Carolina Herrera", categoria: "Perfume" },
  { codigo: "PERF-1MI", nome: "1 Million 100ml", marca: "Paco Rabanne", categoria: "Perfume" },
  { codigo: "FONE-A54", nome: "Fone Bluetooth A54", marca: "Genérico", categoria: "Fone" },
];

const nomes = (consulta: string): string[] =>
  ordenarPorRelevancia(CATALOGO, consulta).map((a) => a.produto.nome);

describe("a capacidade que o cliente disse ELIMINA quem não a tem", () => {
  it("quem pede 128 NÃO vê o 256 — nem em segundo lugar", () => {
    // O caso que justifica a busca inteira. Se este falhar, o agente pode
    // responder o preço do 256GB para quem perguntou do 128GB.
    const r = nomes("iphone 15 128");

    expect(r).toEqual(["iPhone 15 128GB Preto"]);
    expect(r.join(" ")).not.toContain("256");
  });

  it("quem pede 256 não vê o 128", () => {
    const r = nomes("iphone 15 pro 256");

    expect(r).toContain("iPhone 15 Pro 256GB Titânio");
    expect(r.join(" ")).not.toContain("128");
  });

  it("o número casa a unidade colada, mas NÃO um número que só começa igual", () => {
    // "15" não pode casar "153ml". Com a regra ingênua de prefixo, medido, um
    // "Fone Bluetooth A54 153ml" apareceu NA FRENTE dos iPhones — o "15" casou
    // "153ml" e o "ifone" casou "fone".
    expect(pontuar({ nome: "iPhone 15 128GB", codigo: "X" }, tokenizar("128"))).not.toBeNull();
    expect(pontuar({ nome: "Perfume 153ml", codigo: "X" }, tokenizar("15"))).toBeNull();
    expect(pontuar({ nome: "Memória 1256GB", codigo: "X" }, tokenizar("256"))).toBeNull();
  });
});

describe("a palavra é difusa — o cliente erra a digitação", () => {
  it('"ifone" acha os iPhones', () => {
    const r = nomes("ifone 15");

    expect(r.length).toBeGreaterThan(0);
    expect(r.every((n) => n.startsWith("iPhone"))).toBe(true);
  });

  it('"ifone" prefere o iPhone ao Fone — a nota é a QUALIDADE do casamento', () => {
    // O caso que derrubou a primeira versão desta busca. "ifone" casa "fone"
    // (uma letra a mais) e "iphone" (uma a mais e uma trocada): com nota
    // binária os dois empatavam, e um fone de ouvido aparecia ao lado de um
    // celular de dez mil reais. A nota por qualidade desempata.
    const achados = ordenarPorRelevancia(CATALOGO, "ifone");

    expect(achados[0]?.produto.nome).toContain("iPhone");
    const fone = achados.find((a) => a.produto.nome.startsWith("Fone"));
    const iphone = achados.find((a) => a.produto.nome.startsWith("iPhone"));
    if (fone && iphone) expect(iphone.nota).toBeGreaterThan(fone.nota);
  });

  it('"macbook ar" acha o MacBook Air, e só ele', () => {
    expect(nomes("macbook ar")).toEqual(["MacBook Air M3 256GB"]);
  });

  it("acha por marca e por categoria, não só pelo nome", () => {
    // O cliente diz "perfume", e a palavra não está no nome de nenhum produto —
    // está na categoria. Sem isso, "perfume 212" não acharia nada.
    expect(nomes("perfume 212")).toEqual(["212 Sexy Men 100ml", "212 VIP Men 100ml"]);
  });

  it("acha pelo código interno, que é como a loja pergunta", () => {
    expect(nomes("IP15P-256-TIT")).toContain("iPhone 15 Pro 256GB Titânio");
  });
});

describe("o número que NÃO é atributo não pode zerar a busca", () => {
  /**
   * O filtro numérico existe para o 128 não virar 256. Mas ele tratava TODO
   * número da frase como atributo, e o cliente diz números que não são
   * atributo de produto nenhum. Medido no catálogo real de uma loja:
   *
   *     "quero 2 iphone 15"  ->  0 resultados
   *
   * Zero resultado num pedido de compra explícito é o pior desfecho possível:
   * o agente responde "não encontrei" para quem estava comprando.
   *
   * A regra se calibra sozinha no catálogo — um número só filtra se APARECE em
   * algum produto.
   */
  it('"quero 2 iphone 15" acha o iPhone 15 — o "2" é quantidade, não capacidade', () => {
    expect(nomes("quero 2 iphone 15")).toContain("iPhone 15 128GB Preto");
  });

  it('"tenho 3000 pra gastar num iphone" não zera por causa do orçamento', () => {
    const r = nomes("tenho 3000 pra gastar num iphone");
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((n) => n.startsWith("iPhone"))).toBe(true);
  });

  it("⚠️ o número que EXISTE no catálogo continua eliminando, e devolve VAZIO", () => {
    // "512" está no catálogo (no MacBook), então é vocabulário de atributo:
    // quem pede um iPhone de 512 recebe vazio, que é a resposta certa.
    const comMacBook = [...CATALOGO, { codigo: "MBP-512", nome: "MacBook Pro 512GB", marca: "Apple", categoria: "Notebook" }];
    expect(ordenarPorRelevancia(comMacBook, "iphone 15 512")).toEqual([]);
  });

  it("⚠️ NA LOJA QUE NÃO TEM 512 EM LUGAR NENHUM, o achado vem MARCADO como relaxado", () => {
    // O contraexemplo que derruba a regra ingênua de "descartar o número que o
    // catálogo não conhece": numa loja pequena e homogênea — só 128 e 256 — o
    // 512 deixaria de ser vocabulário, sumiria do filtro, e quem pediu 512
    // receberia o preço do 128 EM SILÊNCIO. É o erro que esta busca existe para
    // não cometer, e loja pequena é o cliente deste produto.
    //
    // A busca acha, mas DIZ que ignorou o 512. Quem chama tem de confirmar com
    // o cliente em vez de responder como se fosse o pedido.
    const r = buscarComRelaxamento(CATALOGO, "iphone 15 pro 512");
    expect(r.ignorados).toEqual(["512"]);
    expect(r.achados.length).toBeGreaterThan(0);
  });

  it("a busca que acha SEM relaxar não marca nada (controle positivo)", () => {
    // Sem este caso, "marca sempre" satisfaria o anterior — e aí o agente
    // pediria confirmação de tudo, que é ruído até virar ignorado.
    const r = buscarComRelaxamento(CATALOGO, "iphone 15 128");
    expect(r.ignorados).toEqual([]);
    expect(r.achados.map((a) => a.produto.nome)).toEqual(["iPhone 15 128GB Preto"]);
  });

  it('"quero 2 iphone 15" vem marcado: o "2" foi ignorado', () => {
    const r = buscarComRelaxamento(CATALOGO, "quero 2 iphone 15");
    expect(r.ignorados).toEqual(["2"]);
    expect(r.achados.length).toBeGreaterThan(0);
  });

  it("consulta que vira só quantidade não devolve o catálogo inteiro", () => {
    // Descartar todos os números pode esvaziar a consulta. Devolver tudo seria
    // pior que devolver nada: o agente listaria 50 produtos para quem disse "2".
    expect(nomes("quero 2")).toEqual([]);
  });
});

describe("o que a busca recusa — e recusar é a função", () => {
  it("produto que não existe devolve NADA, não o parecido", () => {
    // Devolver "o mais próximo" aqui seria o pior desfecho: o agente
    // responderia preço de geladeira com o valor de um iPhone.
    expect(nomes("geladeira brastemp")).toEqual([]);
  });

  it('"1 million" não aparece para quem pediu 212', () => {
    // O controle do filtro numérico: os três são perfume de 100ml, e só o
    // número separa.
    const r = nomes("perfume 212 masculino");

    expect(r.join(" ")).not.toContain("1 Million");
  });

  it("consulta vazia ou só de ruído não devolve o catálogo inteiro", () => {
    expect(nomes("")).toEqual([]);
    expect(nomes("de do com para")).toEqual([]);
  });
});

describe("o empate é PRESERVADO — quem escolhe é a pessoa", () => {
  it('"iphone 15 pro 256" devolve o Pro e o Pro Max, os dois', () => {
    // A ambiguidade é real: os dois casam tudo que foi dito. Esconder um seria
    // o modelo escolhendo por conta própria entre dois preços diferentes.
    const achados = ordenarPorRelevancia(CATALOGO, "iphone 15 pro 256");

    expect(achados).toHaveLength(2);
    expect(achados[0]?.nota).toBe(achados[1]?.nota);
  });

  it('"iphone 15 pro max 256" desempata para o Pro Max', () => {
    // O controle do caso acima: com mais uma palavra, a ambiguidade some. Se
    // este falhasse, o empate anterior seria incapacidade e não fidelidade.
    expect(nomes("iphone 15 pro max 256")[0]).toBe("iPhone 15 Pro Max 256GB Titânio");
  });
});
