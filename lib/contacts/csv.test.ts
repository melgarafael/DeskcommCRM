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

  it("NIF do BI mantém as letras de província (não é só dígito, ao contrário do CPF)", () => {
    const idxComNif = mapHeader(["Nome", "Telefone", "Email", "NIF"]).indices;
    const { contato } = mapLinha(
      ["Ana", "+5511999998888", "ana@exemplo.com", "003862011LA042"],
      idxComNif,
    );
    expect(contato.cpf).toBe("003862011LA042");
  });

  it("aceita cabeçalho 'nif' como apelido, e normaliza separador sem remover letra", () => {
    const idxComNif = mapHeader(["Nome", "Telefone", "nif"]).indices;
    const { contato } = mapLinha(["Ana", "+5511999998888", "003.862.011-la-042"], idxComNif);
    expect(contato.cpf).toBe("003862011LA042");
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
