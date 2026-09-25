import { describe, expect, it } from "vitest";

import { lerPlanilhaDeLeads } from "./planilha";

/**
 * `traduzir()` real só troca a CHAVE que bate byte a byte com uma entrada do
 * dicionário; o resto degrada para o próprio texto. Ver o comentário gêmeo em
 * `lib/catalogo/planilha.test.ts` — de lá veio o bug real que motivou este
 * arquivo: um parêntese de fechamento colado DENTRO da chave traduzida não bate
 * com a entrada do dicionário (que não tem o parêntese), e a mensagem sai meio
 * em português. Um mock que traduz QUALQUER string não pega esse descasamento.
 */
const DICIONARIO_FAKE: Record<string, string> = {
  "A planilha está vazia.": "LA PLANILLA ESTÁ VACÍA.",
  "A planilha precisa de uma coluna com o nome do negócio ou do contato. Encontrei: ":
    "LA PLANILLA NECESITA UNA COLUMNA CON EL NOMBRE DEL NEGOCIO O DEL CONTACTO. ENCONTRÉ: ",
  "nenhuma coluna": "NINGUNA COLUMNA",
  "sem nome do negócio nem do contato": "SIN NOMBRE DEL NEGOCIO NI DEL CONTACTO",
  "valor não reconhecido (": "VALOR NO RECONOCIDO (",
  " — escreva assim: 1.200,00": " — ESCRÍBALO ASÍ: 1.200,00",
  "telefone não reconhecido (": "TELÉFONO NO RECONOCIDO (",
  " — o negócio entrou sem contato": " — EL NEGOCIO ENTRÓ SIN CONTACTO",
};
const gritar = (texto: string): string => DICIONARIO_FAKE[texto] ?? texto;

describe("lerPlanilhaDeLeads — mensagens de erro passam por t()", () => {
  it("planilha vazia", () => {
    const resultado = lerPlanilhaDeLeads("", gritar);
    expect(resultado).toEqual({ erro: "LA PLANILLA ESTÁ VACÍA." });
  });

  it("sem coluna de nome nem de contato", () => {
    const csv = "telefone\n11999999999\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    expect(resultado).toEqual({
      erro: "LA PLANILLA NECESITA UNA COLUMNA CON EL NOMBRE DEL NEGOCIO O DEL CONTACTO. ENCONTRÉ: telefone.",
    });
  });

  it("linha sem nome de negócio nem de contato", () => {
    const csv = "nome,telefone\n,11999999999\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe("SIN NOMBRE DEL NEGOCIO NI DEL CONTACTO");
  });

  it("valor não reconhecido — traduz por completo, incluindo o texto após o valor cru", () => {
    const csv = "nome,valor\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('VALOR NO RECONOCIDO ("abc") — ESCRÍBALO ASÍ: 1.200,00');
  });

  it("telefone não reconhecido — traduz por completo", () => {
    const csv = "nome,telefone\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv, gritar);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe(
      'TELÉFONO NO RECONOCIDO ("abc") — EL NEGOCIO ENTRÓ SIN CONTACTO',
    );
    // Telefone ilegível não derruba a linha: o lead entra mesmo assim.
    expect(resultado.leads).toHaveLength(1);
  });

  it("sem função t: comportamento idêntico ao de antes (degrada para o texto original)", () => {
    const csv = "nome,valor\nNegócio,abc\n";
    const resultado = lerPlanilhaDeLeads(csv);
    if ("erro" in resultado) throw new Error("não deveria ser erro de planilha inteira");
    expect(resultado.erros[0]!.motivo).toBe('valor não reconhecido ("abc") — escreva assim: 1.200,00');
  });
});

/**
 * Um apelido por linha, os de antes e os de espanhol — e não uma amostra: o
 * mapa de colunas para no primeiro campo que contém o cabeçalho, então um
 * apelido repetido em dois campos cairia em silêncio no primeiro, e só uma
 * linha por apelido denuncia isso. `colunasIgnoradas` vazio é o que prova que o
 * cabeçalho foi reconhecido; o efeito no lead prova em QUAL campo.
 */
describe("lerPlanilhaDeLeads — todo apelido de coluna cai no seu campo", () => {
  type Lead = Extract<ReturnType<typeof lerPlanilhaDeLeads>, { leads: unknown }>["leads"][number];

  // célula que o campo entende + o que sai dela no lead
  const CAMPOS: Record<string, { celula: string; le: (l: Lead) => unknown; esperado: unknown }> = {
    titulo: { celula: "Reforma", le: (l) => [l.title, l.nome_do_contato], esperado: ["Reforma", null] },
    contato: { celula: "Ana", le: (l) => l.nome_do_contato, esperado: "Ana" },
    telefone: { celula: "11999998888", le: (l) => l.telefone, esperado: "+5511999998888" },
    email: { celula: "ana@exemplo.com", le: (l) => l.email, esperado: "ana@exemplo.com" },
    descricao: { celula: "texto livre", le: (l) => l.description, esperado: "texto livre" },
    valor: { celula: "1.200,00", le: (l) => l.value_cents, esperado: 120000 },
    origem: { celula: "feira", le: (l) => l.source, esperado: "feira" },
    etiquetas: { celula: "vip;novo", le: (l) => l.tags, esperado: ["vip", "novo"] },
  };

  const APELIDOS: ReadonlyArray<readonly [campo: string, apelido: string]> = [
    // pt-BR / en (o que já existia)
    ...["nome", "titulo", "título", "lead", "negocio", "negócio", "oportunidade", "empresa", "assunto"].map(
      (a) => ["titulo", a] as const,
    ),
    ...["nome do contato", "contato", "responsavel", "responsável", "pessoa"].map((a) => ["contato", a] as const),
    ...["telefone", "celular", "whatsapp", "fone", "phone"].map((a) => ["telefone", a] as const),
    ...["email", "e-mail"].map((a) => ["email", a] as const),
    ...["descricao", "descrição", "observacao", "observação", "observacoes", "observações", "notas", "detalhes"].map(
      (a) => ["descricao", a] as const,
    ),
    ...["valor", "preco", "preço", "ticket", "value"].map((a) => ["valor", a] as const),
    ...["origem", "fonte", "canal", "source"].map((a) => ["origem", a] as const),
    ...["tags", "etiquetas", "marcadores"].map((a) => ["etiquetas", a] as const),
    // es — como o Excel escreve, com acento e caixa
    ...["Nombre", "Oportunidad", "Asunto"].map((a) => ["titulo", a] as const),
    ...["Nombre del contacto", "Contacto", "Responsable", "Persona"].map((a) => ["contato", a] as const),
    ...["Teléfono", "Móvil"].map((a) => ["telefone", a] as const),
    ...["Correo", "Correo electrónico"].map((a) => ["email", a] as const),
    ...["Descripción", "Observación", "Observaciones", "Detalles"].map((a) => ["descricao", a] as const),
    ...["Precio", "Importe", "Monto"].map((a) => ["valor", a] as const),
    ...["Origen", "Fuente"].map((a) => ["origem", a] as const),
  ];

  it.each(APELIDOS)("%s ← %s", (campo, apelido) => {
    const { celula, le, esperado } = CAMPOS[campo]!;
    // Sem âncora nas colunas de nome, o campo testado é a única coluna; nos
    // demais, uma coluna `titulo` nomeia o card e o apelido vai ao lado.
    const nomeia = campo === "titulo" || campo === "contato";
    const csv = nomeia ? `${apelido}\n${celula}\n` : `titulo,${apelido}\nNegócio,${celula}\n`;
    const resultado = lerPlanilhaDeLeads(csv);
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(le(resultado.leads[0]!)).toEqual(esperado);
  });
});

describe("lerPlanilhaDeLeads — planilha em espanhol", () => {
  it("cabeçalho completo como o Excel escreve", () => {
    const csv = [
      "Nombre;Nombre del contacto;Teléfono;Correo electrónico;Descripción;Precio;Origen;Etiquetas",
      "Reforma de cocina;Ana García;+34 612 345 678;ana@ejemplo.com;Pidió presupuesto;1.200,50;Feria;vip, nuevo",
    ].join("\n");
    const resultado = lerPlanilhaDeLeads(csv);
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.erros).toEqual([]);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.leads).toEqual([
      {
        linha: 2,
        title: "Reforma de cocina",
        description: "Pidió presupuesto",
        value_cents: 120050,
        telefone: "+34612345678",
        nome_do_contato: "Ana García",
        email: "ana@ejemplo.com",
        tags: ["vip", "nuevo"],
        source: "Feria",
      },
    ]);
  });

  it("separada por vírgula, com móvil e observaciones", () => {
    const csv = [
      "Nombre,Contacto,Móvil,Correo,Observaciones",
      "Curso de inglés,Luis Pérez,+34 699 111 222,luis@ejemplo.com,Llamar el lunes",
    ].join("\n");
    const resultado = lerPlanilhaDeLeads(csv);
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.leads[0]).toMatchObject({
      title: "Curso de inglés",
      nome_do_contato: "Luis Pérez",
      telefone: "+34699111222",
      email: "luis@ejemplo.com",
      description: "Llamar el lunes",
    });
  });

  it("cabeçalho misto pt + es", () => {
    const resultado = lerPlanilhaDeLeads("Nome,Teléfono,Correo\nLoja,11999998888,a@b.co\n");
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.colunasIgnoradas).toEqual([]);
    expect(resultado.leads[0]).toMatchObject({ title: "Loja", telefone: "+5511999998888", email: "a@b.co" });
  });

  it("dois cabeçalhos do mesmo campo: o primeiro vale, o segundo é dito como ignorado", () => {
    const resultado = lerPlanilhaDeLeads("Nombre,Asunto\nUno,Dos\n");
    if ("erro" in resultado) throw new Error(`planilha recusada: ${resultado.erro}`);
    expect(resultado.leads[0]!.title).toBe("Uno");
    expect(resultado.colunasIgnoradas).toEqual(["Asunto"]);
  });

  it("só teléfono e correo, sem nome do negócio nem do contato, segue recusada", () => {
    const resultado = lerPlanilhaDeLeads("Teléfono,Correo\n11999998888,a@b.co\n");
    expect(resultado).toEqual({
      erro: "A planilha precisa de uma coluna com o nome do negócio ou do contato. Encontrei: Teléfono, Correo.",
    });
  });
});
