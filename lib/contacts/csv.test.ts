import { describe, expect, it } from "vitest";

import {
  CSV_MAX_DATA_ROWS,
  CSV_MAX_BYTES,
  mapHeader,
  mapLinha,
  normalizaData,
  normalizaTelefone,
  parseCsv,
} from "./csv";

describe("parseCsv", () => {
  it("parseia linhas simples com vírgula", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("remove BOM UTF-8 do Excel", () => {
    expect(parseCsv("\uFEFFnome,tel\nana,+5511")).toEqual([["nome", "tel"], ["ana", "+5511"]]);
  });

  it("aceita ponto-e-vírgula (export pt-BR do Excel)", () => {
    expect(parseCsv("nome;telefone\nAna;+5511999998888")).toEqual([
      ["nome", "telefone"],
      ["Ana", "+5511999998888"],
    ]);
  });

  it("aceita tabulação", () => {
    expect(parseCsv("nome\ttelefone\nAna\t+5511")).toEqual([
      ["nome", "telefone"],
      ["Ana", "+5511"],
    ]);
  });

  it("campo entre aspas com vírgula e quebra de linha dentro", () => {
    const csv = 'nome,obs\n"Silva, Maria","linha1\nlinha2"';
    expect(parseCsv(csv)).toEqual([
      ["nome", "obs"],
      ["Silva, Maria", "linha1\nlinha2"],
    ]);
  });

  it('aspas escapadas como "" viram uma aspa literal', () => {
    expect(parseCsv('a,b\n"Ele disse ""oi""",x')).toEqual([
      ["a", "b"],
      ['Ele disse "oi"', "x"],
    ]);
  });

  it("aceita CRLF e CR sozinho (Excel/legado Mac)", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("descarta linha vazia final", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("aspas só abrem campo se estiver no início dele (não come o resto)", () => {
    // `ab"c` — aspa no meio do campo é literal, não abre bloco citado.
    expect(parseCsv('a\nab"c')).toEqual([["a"], ['ab"c']]);
  });
});

describe("mapHeader", () => {
  it("mapeia apelidos pt-BR com acento e caixa", () => {
    const { indices, motivo } = mapHeader(["Nome", "WhatsApp", "E-Mail", "Data de Nascimento"]);
    expect(motivo).toBeNull();
    expect(indices.name).toBe(0);
    expect(indices.phone_number).toBe(1);
    expect(indices.email).toBe(2);
    expect(indices.birthdate).toBe(3);
  });

  it("sem identificador (telefone/e-mail) falha aberto com motivo", () => {
    const { motivo } = mapHeader(["Nome", "Idade"]);
    expect(motivo).toMatch(/sem coluna de telefone nem e-mail/);
  });
});

/**
 * Cobre TODO apelido, e não uma amostra: um apelido repetido em dois campos cai
 * em silêncio no primeiro (`mapHeader` para no primeiro que contém a célula),
 * e só uma linha por apelido denuncia isso. Os de espanhol são a promessa da
 * frase "columnas reconocidas: nombre, teléfono, email…" do diálogo de importação.
 */
describe("mapHeader — todo apelido reconhecido cai no seu campo", () => {
  it.each([
    // pt-BR / en (o que já existia)
    ["name", "name"],
    ["nome", "name"],
    ["cliente", "name"],
    ["display_name", "display_name"],
    ["apelido", "display_name"],
    ["nome_de_exibicao", "display_name"],
    ["email", "email"],
    ["e_mail", "email"],
    ["phone_number", "phone_number"],
    ["telefone", "phone_number"],
    ["whatsapp", "phone_number"],
    ["celular", "phone_number"],
    ["fone", "phone_number"],
    ["cpf", "cpf"],
    ["birthdate", "birthdate"],
    ["nascimento", "birthdate"],
    ["data_de_nascimento", "birthdate"],
    ["aniversario", "birthdate"],
    ["tags", "tags"],
    ["etiquetas", "tags"],
    ["grupos", "tags"],
    // es
    ["nombre", "name"],
    ["apodo", "display_name"],
    ["nombre_para_mostrar", "display_name"],
    ["correo", "email"],
    ["correo_electronico", "email"],
    ["telefono", "phone_number"],
    ["movil", "phone_number"],
    ["nacimiento", "birthdate"],
    ["fecha_de_nacimiento", "birthdate"],
    ["cumpleanos", "birthdate"],
  ])("%s → %s", (alias, campo) => {
    expect(mapHeader([alias]).indices).toEqual({ [campo]: 0 });
  });
});

describe("mapHeader — cabeçalho em espanhol como o Excel escreve", () => {
  it("acento, caixa e espaços: Nombre, Teléfono, Correo electrónico…", () => {
    const { indices, motivo } = mapHeader([
      "Nombre",
      "Nombre para mostrar",
      "Correo electrónico",
      "Teléfono",
      "Fecha de nacimiento",
      "Etiquetas",
    ]);
    expect(motivo).toBeNull();
    expect(indices).toEqual({
      name: 0,
      display_name: 1,
      email: 2,
      phone_number: 3,
      birthdate: 4,
      tags: 5,
    });
  });

  it("Móvil e Cumpleaños (ñ e acento saem na normalização)", () => {
    const { indices, motivo } = mapHeader(["Móvil", "Cumpleaños"]);
    expect(motivo).toBeNull();
    expect(indices).toEqual({ phone_number: 0, birthdate: 1 });
  });

  it("cabeçalho misto pt + es mapeia cada coluna", () => {
    const { indices, motivo } = mapHeader(["Nome", "Teléfono", "Correo", "Nascimento"]);
    expect(motivo).toBeNull();
    expect(indices).toEqual({ name: 0, phone_number: 1, email: 2, birthdate: 3 });
  });

  it("em espanhol, sem telefone nem correo, falha aberto com o mesmo motivo", () => {
    const { motivo } = mapHeader(["Nombre", "Apodo", "Nacimiento"]);
    expect(motivo).toMatch(/sem coluna de telefone nem e-mail/);
  });
});

describe("CSV em espanhol de ponta a ponta (parseCsv → mapHeader → mapLinha)", () => {
  function importa(csv: string) {
    const [cabecalho, linha] = parseCsv(csv);
    const { indices, motivo: motivoHeader } = mapHeader(cabecalho!);
    expect(motivoHeader).toBeNull();
    return mapLinha(linha!, indices);
  }

  it("separado por ponto e vírgula (etiquetas entre aspas, que têm ';' dentro)", () => {
    const { contato, motivo } = importa(
      [
        "nombre;teléfono;correo electrónico;nacimiento;etiquetas",
        'Ana García;+34 612 345 678;ana@ejemplo.com;15/03/1990;"vip; newsletter"',
      ].join("\n"),
    );
    expect(motivo).toBeNull();
    expect(contato.name).toBe("Ana García");
    expect(contato.phone_number).toBe("+34612345678");
    expect(contato.email).toBe("ana@ejemplo.com");
    expect(contato.birthdate).toBe("1990-03-15");
    expect(contato.tags).toEqual(["vip", "newsletter"]);
  });

  it("separado por vírgula, com apodo e móvil", () => {
    const { contato, motivo } = importa(
      [
        "Nombre,Apodo,Móvil,Correo,Fecha de nacimiento,Etiquetas",
        // Etiquetas separam por ';' ou '|' (a vírgula é o delimitador do arquivo).
        "Luis Pérez,Lucho,+34 699 111 222,luis@ejemplo.com,02/11/1985,vip; newsletter",
      ].join("\n"),
    );
    expect(motivo).toBeNull();
    expect(contato.name).toBe("Luis Pérez");
    expect(contato.display_name).toBe("Lucho");
    expect(contato.phone_number).toBe("+34699111222");
    expect(contato.email).toBe("luis@ejemplo.com");
    expect(contato.birthdate).toBe("1985-11-02");
    expect(contato.tags).toEqual(["vip", "newsletter"]);
  });
});

describe("normalizaTelefone", () => {
  it.each([
    ["+5511999998888", "+5511999998888"],
    ["+55 11 99999-8888", "+5511999998888"],
    // ⚠️ ERA `+11999998888` — número quebrado: o `11` é DDD e estava ocupando o
    // lugar do DDI (`+11` são os Estados Unidos). Decisão do dono, 2026-08-24:
    // planilha sem DDI é brasileira, e a regra é a mesma da ingestão de webhook.
    ["(11) 99999-8888", "+5511999998888"],
    ["11999998888", "+5511999998888"],
    ["(11) 3333-4444", "+551133334444"],
    ["5511999998888", "+5511999998888"],
    ["3284793302", "+5532984793302"],
    ["+553284793302", "+5532984793302"],
  ])("%s → %s", (raw, esperado) => {
    expect(normalizaTelefone(raw)).toBe(esperado);
  });

  it.each(["123", "abc", "+5511", "999998888"])("recusa %s", (raw) => {
    expect(normalizaTelefone(raw)).toBeNull();
  });

  it("vazio → null (campo opcional)", () => {
    expect(normalizaTelefone("")).toBeNull();
  });
});

describe("normalizaData", () => {
  it("aceita ISO e BR", () => {
    expect(normalizaData("1990-05-12")).toBe("1990-05-12");
    expect(normalizaData("12/05/1990")).toBe("1990-05-12");
  });

  it("recusa formato solto", () => {
    expect(normalizaData("12-05-90")).toBeNull();
  });
});

describe("mapLinha", () => {
  const indices = mapHeader(["Nome", "Telefone", "Email", "Tags"]).indices;

  it("mapeia linha completa", () => {
    const { contato, motivo } = mapLinha(
      ["Ana Silva", "+55 11 99999-8888", "ana@exemplo.com", "vip; newsletter"],
      indices,
    );
    expect(motivo).toBeNull();
    expect(contato.name).toBe("Ana Silva");
    expect(contato.phone_number).toBe("+5511999998888");
    expect(contato.email).toBe("ana@exemplo.com");
    expect(contato.tags).toEqual(["vip", "newsletter"]);
  });

  it("linha sem telefone e sem e-mail é pulada com motivo", () => {
    const { motivo } = mapLinha(["Só Nome", "", "", ""], indices);
    expect(motivo).toMatch(/sem telefone nem e-mail/);
  });

  it("telefone malformado gera erro nominal da linha", () => {
    const { motivo } = mapLinha(["Ana", "123", "", ""], indices);
    expect(motivo).toMatch(/telefone inválido/);
  });

  it("e-mail malformado gera erro nominal da linha", () => {
    const { motivo } = mapLinha(["Ana", "", "nao-e-email", ""], indices);
    expect(motivo).toMatch(/e-mail inválido/);
  });

  it("células faltando no fim da linha não derrubam o mapeamento", () => {
    const { contato, motivo } = mapLinha(["Ana", "+5511999998888"], indices);
    expect(motivo).toBeNull();
    expect(contato.email).toBeUndefined();
  });
});

/**
 * `traduzir()` real só troca a CHAVE que bate byte a byte com uma entrada do
 * dicionário; o resto degrada para o próprio texto. Um mock que traduz
 * QUALQUER string esconderia um pedaço colado FORA de `t()` que deveria estar
 * dentro (ou vice-versa) — ver o bug real corrigido em
 * `lib/catalogo/planilha.test.ts` e `lib/leads/planilha.test.ts`.
 */
describe("mapHeader / mapLinha — mensagens de erro passam por t()", () => {
  const indices = mapHeader(["Nome", "Telefone", "Email", "Tags"]).indices;
  const DICIONARIO_FAKE: Record<string, string> = {
    "cabeçalho sem coluna de telefone nem e-mail": "CABECERA SIN COLUMNA DE TELÉFONO NI E-MAIL",
    "e-mail inválido: ": "E-MAIL INVÁLIDO: ",
    "telefone inválido: ": "TELÉFONO INVÁLIDO: ",
    " (use DDI+DDD+número, ex.: +5511999998888)":
      " (USA CÓDIGO DE PAÍS+CÓDIGO DE ÁREA+NÚMERO, EJ.: +5511999998888)",
    "linha sem telefone nem e-mail": "LÍNEA SIN TELÉFONO NI E-MAIL",
  };
  const gritar = (texto: string): string => DICIONARIO_FAKE[texto] ?? texto;

  it("mapHeader: sem identificador traduz por completo", () => {
    const { motivo } = mapHeader(["Nome", "Idade"], gritar);
    expect(motivo).toBe("CABECERA SIN COLUMNA DE TELÉFONO NI E-MAIL");
  });

  it("mapHeader: sem t, comportamento idêntico ao de antes", () => {
    const { motivo } = mapHeader(["Nome", "Idade"]);
    expect(motivo).toBe("cabeçalho sem coluna de telefone nem e-mail");
  });

  it("mapLinha: sem telefone/e-mail traduz por completo", () => {
    const { motivo } = mapLinha(["Só Nome", "", "", ""], indices, gritar);
    expect(motivo).toBe("LÍNEA SIN TELÉFONO NI E-MAIL");
  });

  it("mapLinha: telefone inválido traduz por completo, incluindo o texto após o valor cru", () => {
    const { motivo } = mapLinha(["Ana", "123", "", ""], indices, gritar);
    expect(motivo).toBe(
      'TELÉFONO INVÁLIDO: "123" (USA CÓDIGO DE PAÍS+CÓDIGO DE ÁREA+NÚMERO, EJ.: +5511999998888)',
    );
  });

  it("mapLinha: e-mail inválido traduz por completo", () => {
    const { motivo } = mapLinha(["Ana", "", "nao-e-email", ""], indices, gritar);
    expect(motivo).toBe('E-MAIL INVÁLIDO: "nao-e-email"');
  });

  it("mapLinha: sem t, comportamento idêntico ao de antes (degrada para o texto original)", () => {
    const { motivo } = mapLinha(["Ana", "123", "", ""], indices);
    expect(motivo).toBe('telefone inválido: "123" (use DDI+DDD+número, ex.: +5511999998888)');
  });
});

describe("limites declarados", () => {
  it("teto de linhas e tamanho são os mesmos que a rota cobra", () => {
    // Guarda barata: a rota lê estas constantes; o teste existe para o dia em
    // que alguém mudar um lado sem ver o outro.
    expect(CSV_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(CSV_MAX_DATA_ROWS).toBe(500);
  });
});

describe("normalizaData recusa data com forma certa e dia inexistente", () => {
  it.each(["31/02/1990", "30/02/2020", "31/04/2021", "1990-02-31", "2021-13-01"])(
    "recusa %s",
    (raw) => {
      // Sem esta conferência a data passava por FORMATO e morria no Postgres com
      // erro cru — a planilha inteira falhava com mensagem de banco, em vez de a
      // LINHA falhar com "dia inválido", que é o que a tela promete.
      expect(normalizaData(raw)).toBeNull();
    },
  );

  it("29/02 em ano BISSEXTO continua valendo — a guarda não pode ser larga demais", () => {
    expect(normalizaData("29/02/2024")).toBe("2024-02-29");
    expect(normalizaData("29/02/2023")).toBeNull();
  });
});
