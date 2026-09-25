import { describe, expect, it } from "vitest";

import { lerPlanilha } from "./planilha";

/**
 * `traduzir()` real só troca a CHAVE que bate byte a byte com uma entrada do
 * dicionário; o resto degrada para o próprio texto (`lib/i18n/dicionario.ts`).
 * Um mock que maiusculiza QUALQUER string escondia o bug real: a chave que o
 * código montava (`") — escreva assim…"`, com o parêntese dentro de `t()`)
 * nunca bateu com a entrada do dicionário (sem o parêntese) — e um mock
 * "universal" não reproduz esse descasamento, porque ele nunca falha em
 * traduzir nada. Este fake replica o comportamento de fallback: só a chave
 * que está no mapa mock é transformada; o resto sai como entrou.
 */
const DICIONARIO_FAKE: Record<string, string> = {
  "preço não reconhecido (": "PRECIO NO RECONOCIDO (",
  " — escreva assim: 5.499,00": " — ESCRÍBALO ASÍ: 5.499,00",
  "custo não reconhecido (": "COSTO NO RECONOCIDO (",
  'código repetido na planilha ("{codigo}") — já está na linha {linha}':
    'CÓDIGO REPETIDO EN LA PLANILLA ("{codigo}") — YA ESTÁ EN LA FILA {linha}',
};
const gritar = (texto: string): string => DICIONARIO_FAKE[texto] ?? texto;

describe("lerPlanilha — mensagens de erro passam por t()", () => {
  it("traduz a mensagem de preço não reconhecido por completo, incluindo o texto após o valor cru", () => {
    const csv = "codigo,nome,preco\nX1,Produto,abc\n";
    const resultado = lerPlanilha(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros).toHaveLength(1);
    // O valor cru ("abc") não passa por t() — só o texto fixo ao redor, e
    // TODO ele: um pedaço que ficasse fora de `_t()` bateria com uma chave
    // ausente do DICIONARIO_FAKE e sairia em português, reprovando o teste.
    const motivo = resultado.erros[0]!.motivo;
    expect(motivo).toBe('PRECIO NO RECONOCIDO ("abc") — ESCRÍBALO ASÍ: 5.499,00');
  });

  it("traduz custo não reconhecido por completo", () => {
    const csv = "codigo,nome,preco,custo\nX1,Produto,10.00,xyz\n";
    const resultado = lerPlanilha(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('COSTO NO RECONOCIDO ("xyz")');
  });

  it("traduz código repetido por completo", () => {
    const csv = "codigo,nome,preco\nDUP,Um,10.00\nDUP,Dois,20.00\n";
    const resultado = lerPlanilha(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('CÓDIGO REPETIDO EN LA PLANILLA ("DUP") — YA ESTÁ EN LA FILA 2');
  });

  it("código repetido sem função t sai inteiro em português, com a linha da primeira ocorrência", () => {
    const csv = "codigo,nome,preco\nDUP,Um,10.00\nDUP,Dois,20.00\n";
    const resultado = lerPlanilha(csv);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('código repetido na planilha ("DUP") — já está na linha 2');
  });

  it("sem função t: comportamento idêntico ao de antes (degrada para o texto original)", () => {
    const csv = "codigo,nome,preco\nX1,Produto,abc\n";
    const resultado = lerPlanilha(csv);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('preço não reconhecido ("abc") — escreva assim: 5.499,00');
  });
});

/**
 * A RECUSA DIZ QUAL COLUNA FALTA — e isso vale nos DOIS idiomas.
 *
 * ─── O defeito que este bloco guarda ────────────────────────────────────────
 *
 * A mensagem era montada com o que de fato faltava
 * (`faltando.map(...).join(" e de ")`). Ao virar chave de tradução ela virou
 * uma frase FIXA: "precisa de uma coluna de nome e de preço", dita também para
 * quem já tinha a coluna `nome` e só não tinha a de preço.
 *
 * Quem recebe esse texto vai conferir a coluna `nome` — que está lá —, não
 * encontra o erro que a mensagem descreve, e desiste do arquivo. É a primeira
 * tela do catálogo, e o idioma majoritário do produto é o português: a
 * tradução não pode custar informação a quem já usava o sistema.
 *
 * ─── Por que o caso "faltam as duas" está aqui mesmo não discriminando ──────
 *
 * Ele passa nas duas versões, de propósito: é o par do «não faça X». Sem ele,
 * "sempre diga só uma coluna" satisfaria os outros dois casos e quebraria a
 * frase de quem manda uma planilha sem cabeçalho nenhum.
 */
const ES: Record<string, string> = {
  "A planilha precisa de uma coluna de nome. Encontrei: ":
    "La planilla necesita una columna de nombre. Encontré: ",
  "A planilha precisa de uma coluna de preço. Encontrei: ":
    "La planilla necesita una columna de precio. Encontré: ",
  "A planilha precisa de uma coluna de nome e de preço. Encontrei: ":
    "La planilla necesita una columna de nombre y de precio. Encontré: ",
};
const espanhol = (texto: string): string => ES[texto] ?? texto;

function recusa(csv: string, t?: (s: string) => string): string {
  const r = lerPlanilha(csv, t);
  if (!("erro" in r)) throw new Error("a planilha deveria ter sido recusada inteira");
  return r.erro;
}

describe("lerPlanilha — a recusa nomeia a coluna que falta", () => {
  it("tem nome, falta preço: pede PREÇO e não menciona a coluna que já existe", () => {
    const erro = recusa("nome,marca\nCafé,Melitta\n");
    expect(erro).toBe("A planilha precisa de uma coluna de preço. Encontrei: nome, marca.");
    // A asserção que reprova a frase fixa: ela pediria "nome e de preço".
    expect(erro).not.toContain("coluna de nome");
  });

  it("tem preço, falta nome: pede NOME", () => {
    const erro = recusa("preco,marca\n9.90,Melitta\n");
    expect(erro).toBe("A planilha precisa de uma coluna de nome. Encontrei: preco, marca.");
    expect(erro).not.toContain("de preço");
  });

  it("faltam as duas: pede as duas", () => {
    const erro = recusa("marca,categoria\nMelitta,Café\n");
    expect(erro).toBe(
      "A planilha precisa de uma coluna de nome e de preço. Encontrei: marca, categoria.",
    );
  });

  it("em espanhol, a coluna que falta continua sendo a nomeada", () => {
    // A intenção do PR #600 — quem usa espanhol lê espanhol — sobrevive ao
    // conserto: o que não podia sobreviver era perder QUAL coluna falta.
    const erro = recusa("nome,marca\nCafé,Melitta\n", espanhol);
    expect(erro).toBe("La planilla necesita una columna de precio. Encontré: nome, marca.");
    expect(erro).not.toContain("de nombre");
  });
});

/**
 * Um apelido por linha, os de antes e os de espanhol — e não uma amostra: o
 * mapa de colunas para no primeiro campo que contém o cabeçalho, então um
 * apelido repetido em dois campos cairia em silêncio no primeiro, e só uma
 * linha por apelido denuncia isso. O efeito no produto prova em QUAL campo, e
 * `colunasIgnoradas` vazio prova que o cabeçalho foi reconhecido.
 */
describe("lerPlanilha — todo apelido de coluna cai no seu campo", () => {
  type Produto = Extract<ReturnType<typeof lerPlanilha>, { produtos: unknown }>["produtos"][number];

  // Separador `;` sempre: os valores levam vírgula ("1.200,00") e não precisam de aspas.
  const CAMPOS: Record<string, { ancora: string; celula: string; le: (p: Produto) => unknown; esperado: unknown }> = {
    codigo: { ancora: "nome;preco", celula: "ABC-1", le: (p) => p.codigo, esperado: "ABC-1" },
    nome: { ancora: "preco", celula: "Café", le: (p) => p.nome, esperado: "Café" },
    preco: { ancora: "nome", celula: "1.200,00", le: (p) => p.preco_cents, esperado: 120000 },
    custo: { ancora: "nome;preco", celula: "8,50", le: (p) => p.custo_cents, esperado: 850 },
    marca: { ancora: "nome;preco", celula: "Melitta", le: (p) => p.marca, esperado: "Melitta" },
    categoria: { ancora: "nome;preco", celula: "Bebidas", le: (p) => p.categoria, esperado: "Bebidas" },
    quantidade: {
      ancora: "nome;preco",
      celula: "7",
      le: (p) => [p.quantidade, p.controla_estoque],
      esperado: [7, true],
    },
  };
  // Célula das colunas âncora, na ordem em que aparecem em `ancora`.
  const CELULA_ANCORA: Record<string, string> = { nome: "Café", preco: "10" };

  const APELIDOS: ReadonlyArray<readonly [campo: string, apelido: string]> = [
    // pt-BR / en (o que já existia)
    ...["codigo", "código", "sku", "ref", "referencia", "referência", "cod"].map((a) => ["codigo", a] as const),
    ...["nome", "produto", "descricao", "descrição", "titulo", "título", "item"].map((a) => ["nome", a] as const),
    ...["preco", "preço", "valor", "preco de venda", "preço de venda", "venda"].map((a) => ["preco", a] as const),
    ...["custo", "preco de custo", "preço de custo", "compra"].map((a) => ["custo", a] as const),
    ...["marca", "fabricante"].map((a) => ["marca", a] as const),
    ...["categoria", "tipo", "departamento"].map((a) => ["categoria", a] as const),
    ...["quantidade", "estoque", "qtd", "qtde", "qty"].map((a) => ["quantidade", a] as const),
    // es — como o Excel escreve, com acento e caixa. Os quatro primeiros grupos
    // já valiam por coincidirem com o português (Código, Categoría, Marca, Compra…).
    ...["Código", "Referencia"].map((a) => ["codigo", a] as const),
    ...["Categoría", "Departamento"].map((a) => ["categoria", a] as const),
    ...["Marca", "Fabricante"].map((a) => ["marca", a] as const),
    ...["Compra"].map((a) => ["custo", a] as const),
    // …e os que só o espanhol escreve:
    ...["Nombre", "Producto", "Descripción", "Artículo"].map((a) => ["nome", a] as const),
    ...["Precio", "Precio de venta", "Venta"].map((a) => ["preco", a] as const),
    ...["Costo", "Coste", "Precio de costo", "Precio de coste"].map((a) => ["custo", a] as const),
    ...["Cantidad", "Existencias", "Stock"].map((a) => ["quantidade", a] as const),
  ];

  it.each(APELIDOS)("%s ← %s", (campo, apelido) => {
    const { ancora, celula, le, esperado } = CAMPOS[campo]!;
    const cabecalho = `${apelido};${ancora}`;
    const linha = `${celula};${ancora.split(";").map((c) => CELULA_ANCORA[c]).join(";")}`;
    const resultado = lerPlanilha(`${cabecalho}\n${linha}\n`);
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(le(resultado.produtos[0]!)).toEqual(esperado);
  });
});

describe("lerPlanilha — planilha em espanhol", () => {
  it("cabeçalho completo como o Excel escreve", () => {
    const csv = [
      "Código;Producto;Precio;Costo;Marca;Categoría;Cantidad",
      "CAF-1;Café molido;1.200,50;800,00;Melitta;Bebidas;12",
    ].join("\n");
    const resultado = lerPlanilha(csv);
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.erros).toEqual([]);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.produtos).toEqual([
      {
        linha: 2,
        codigo: "CAF-1",
        nome: "Café molido",
        preco_cents: 120050,
        custo_cents: 80000,
        marca: "Melitta",
        categoria: "Bebidas",
        quantidade: 12,
        controla_estoque: true,
      },
    ]);
  });

  it("Descripción nomeia o produto (como `descrição` em português) e Precio de venda é o preço", () => {
    const resultado = lerPlanilha("Descripción;Precio de venta;Existencias\nTaza de barro;15,00;3\n");
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.produtos[0]).toMatchObject({
      nome: "Taza de barro",
      preco_cents: 1500,
      quantidade: 3,
      controla_estoque: true,
    });
  });

  it("cabeçalho misto pt + es", () => {
    const resultado = lerPlanilha("Nome;Precio;Estoque\nLivro;30,00;4\n");
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.produtos[0]).toMatchObject({ nome: "Livro", preco_cents: 3000, quantidade: 4 });
  });

  it("sem coluna de nome nem de preço em espanhol, a recusa nomeia as duas e lista o que achou", () => {
    expect(recusa("Marca;Categoría\nMelitta;Café\n")).toBe(
      "A planilha precisa de uma coluna de nome e de preço. Encontrei: Marca, Categoría.",
    );
  });
});
