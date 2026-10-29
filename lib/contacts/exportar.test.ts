/**
 * O writer de export fala com os DOIS readers que o repo já tem.
 *
 * Nada aqui é testado contra uma expectativa escrita à mão: o CSV passa pelo
 * parser da própria tela (`parseCsv` + `mapHeader` + `mapLinha`, o mesmo
 * caminho do `POST /api/v1/contacts/import`) e o vCard passa pelo reader do
 * produto (`parseVcard`, o da #2712). Se o round-trip deixa de fechar, este
 * arquivo fica vermelho — que é a única prova que vale para "reaproveita o que
 * já existe".
 */
import { describe, expect, it } from "vitest";

import { mapHeader, mapLinha, parseCsv } from "@/lib/contacts/csv";
import {
  CABECALHO_DO_CSV,
  COLUNAS_DO_CSV,
  csvDosContatos,
  linhaDoCsv,
  nomeDoArquivo,
  queryDaExportacao,
  vcardDoContato,
  vcardsDosContatos,
  type ContatoParaExportar,
} from "@/lib/contacts/exportar";
import { parseVcard } from "@/lib/messaging/contact-card";

/** CPF de teste: módulo 11 conferido, é o que o validador do país aceita. */
const CPF_VALIDO = "52998224725";

const BASE: ContatoParaExportar[] = [
  {
    name: "Maria da Silva",
    display_name: "Maria",
    email: "maria@exemplo.com.br",
    phone_number: "+5511999998888",
    cpf: CPF_VALIDO,
    tags: ["vip", "orçamento"],
  },
  {
    name: "João Comércio",
    display_name: null,
    email: null,
    phone_number: "+5521988887777",
    cpf: null,
    tags: [],
  },
  {
    name: null,
    display_name: "Ateliê da Praça",
    email: "atelie@exemplo.com.br",
    phone_number: null,
    cpf: null,
    tags: ["cliente"],
  },
];

/** Reprocessa o CSV pelo caminho EXATO do import e devolve as linhas mapeadas. */
function reimporta(csv: string): {
  indices: Record<string, number>;
  linhas: Array<Record<string, string | string[] | undefined>>;
} {
  const rows = parseCsv(csv);
  const mapeado = mapHeader(rows[0]!);
  expect(mapeado.motivo, "o cabeçalho exportado tem de ser aceito pelo import").toBeNull();
  const linhas = rows.slice(1).map((celulas) => {
    const { contato, motivo } = mapLinha(celulas, mapeado.indices);
    expect(motivo, `linha recusada pelo import: ${motivo}`).toBeNull();
    return contato as Record<string, string | string[] | undefined>;
  });
  return { indices: mapeado.indices, linhas };
}

describe("o CSV espelha as colunas que o importer aceita", () => {
  it("⭐ o cabeçalho espelha os campos aceitos na importação, incluindo nascimento", () => {
    expect(CABECALHO_DO_CSV).toBe("name,display_name,email,phone_number,cpf,birthdate,tags");
    expect(COLUNAS_DO_CSV).toEqual([
      "name",
      "display_name",
      "email",
      "phone_number",
      "cpf",
      "birthdate",
      "tags",
    ]);

    const mapeado = mapHeader(CABECALHO_DO_CSV.split(","));
    expect(mapeado.motivo).toBeNull();
    expect(Object.keys(mapeado.indices).sort()).toEqual([...COLUNAS_DO_CSV].sort());
  });

  it("⭐ round-trip: exportar e reimportar devolve as mesmas pessoas, com as mesmas etiquetas", () => {
    const { linhas } = reimporta(csvDosContatos(BASE));

    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toEqual({
      name: "Maria da Silva",
      display_name: "Maria",
      email: "maria@exemplo.com.br",
      phone_number: "+5511999998888",
      cpf: CPF_VALIDO,
      tags: ["vip", "orçamento"],
    });
    // Coluna vazia vira campo AUSENTE do lado do import — é assim que o
    // importer trabalha hoje, e o round-trip tem de casar com ele, não com a
    // linha de cá.
    expect(linhas[1]).toMatchObject({
      name: "João Comércio",
      phone_number: "+5521988887777",
    });
    expect(linhas[1]!.email).toBeUndefined();
    expect(linhas[1]!.tags).toBeUndefined();
    expect(linhas[2]).toMatchObject({
      display_name: "Ateliê da Praça",
      email: "atelie@exemplo.com.br",
    });
  });

  it.each(["1990-05-23", "2000-02-29"])(
    "preserva o nascimento %s ao exportar e reimportar, como data de calendário",
    (birthdate) => {
      const contato = { ...BASE[0]!, birthdate };

      const { linhas } = reimporta(csvDosContatos([contato]));

      expect(linhas[0]!.birthdate).toBe(birthdate);
    },
  );

  it("mantém a coluna de nascimento vazia quando a ficha não tem a data", () => {
    const contato = { ...BASE[0]!, birthdate: null };

    const { indices, linhas } = reimporta(csvDosContatos([contato]));

    expect(indices.birthdate).toBeDefined();
    expect(linhas[0]!.birthdate).toBeUndefined();
  });

  it("as etiquetas saem com `;`, que é o separador que `mapLinha` divide", () => {
    const csv = csvDosContatos([{ name: "Ana", phone_number: "+5511912345678", tags: ["vip", "frio"] }]);
    expect(linhaDoCsv({ phone_number: "+5511912345678", tags: ["vip", "frio"] })).toContain(
      "vip;frio",
    );
    const { linhas } = reimporta(csv);
    expect(linhas[0]!.tags).toEqual(["vip", "frio"]);
  });

  it("vírgula e aspas no nome voltam intactas (RFC 4180, mesmo escape da auditoria)", () => {
    const csv = csvDosContatos([
      { name: 'Silva, Maria "Da"', phone_number: "+5511912345678", tags: [] },
    ]);
    expect(csv).toContain('"Silva, Maria ""Da"""');
    const { linhas } = reimporta(csv);
    expect(linhas[0]!.name).toBe('Silva, Maria "Da"');
  });

  it("célula que começa com caractere de fórmula sai como texto; telefone E.164 não", () => {
    const linha = linhaDoCsv({ name: "=SOMA(1;2)", display_name: "@x", phone_number: "+5511999998888" });
    expect(linha.startsWith("'=SOMA(1;2),'@x,,+5511999998888,")).toBe(true);
  });

  it("trecho depois de `;` que começa com fórmula também sai como texto (Excel pt-BR divide por `;`)", () => {
    const linha = linhaDoCsv({ name: "Ana;=1+1", phone_number: "+5511999998888", tags: ["vip", "=HYPERLINK(\"x\")", "+5511"] });
    expect(linha).toContain("Ana;'=1+1");
    expect(linha.endsWith(`"vip;'=HYPERLINK(""x"");+5511"`)).toBe(true);
    for (const trecho of linha.split(/[;,]/)) expect(trecho.replace(/^"/, "")).not.toMatch(/^[=@]/);
  });

  it("trecho depois de quebra de linha ou de vírgula também sai como texto (leitor que não respeita aspas)", () => {
    const linha = linhaDoCsv({ name: "Ana\n=1+1", display_name: "a,@x", phone_number: "+5511999998888" });
    expect(linha).toContain("Ana\n'=1+1");
    expect(linha).toContain("a,'@x");
    for (const trecho of linha.split(/[;,\n\r]/)) expect(trecho.replace(/^"/, "")).not.toMatch(/^[=@]/);
  });

  it("o BOM sai na frente (Excel pt-BR lê acento) e o import tira ele", () => {
    const csv = csvDosContatos(BASE);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(csv)[0]![0]).toBe("name");
  });

  it("linha vazia não vira contato vazio: sem telefone e sem e-mail o import recusa", () => {
    const csv = csvDosContatos([{ name: "Sem Contato", phone_number: null, email: null }]);
    const rows = parseCsv(csv);
    const mapeado = mapHeader(rows[0]!);
    const { motivo } = mapLinha(rows[1]!, mapeado.indices);
    expect(motivo).toContain("telefone");
  });
});

describe("o vCard é lível pelo reader do próprio produto (#2712)", () => {
  it("⭐ `parseVcard` devolve nome e telefone de cada cartão que escrevemos", () => {
    for (const contato of BASE) {
      const cartao = vcardDoContato(contato);
      expect(cartao).not.toBeNull();
      const lido = parseVcard(cartao!);

      const esperadoNome = contato.name ?? contato.display_name;
      const esperadoTel = contato.phone_number ?? "";
      expect(lido, `reader não leu: ${cartao}`).not.toBeNull();
      if (esperadoNome) expect(lido!.name).toBe(esperadoNome);
      // Sem TEL o reader devolve `null` (é o que `parseVcard` faz hoje) — o
      // contrato aqui é "não inventa telefone", não o tipo da variável.
      expect(lido!.phone_number ?? "").toBe(esperadoTel);
    }
  });

  it("⭐ um arquivo com N cartões — um por contato, e cada um legível sozinho", () => {
    const arquivo = vcardsDosContatos(BASE);
    const cartoes = arquivo.split("BEGIN:VCARD").filter((c) => c.trim() !== "");

    expect(cartoes).toHaveLength(3);
    for (const cartao of cartoes) {
      const lido = parseVcard(`BEGIN:VCARD${cartao}`);
      expect(lido).not.toBeNull();
      expect(lido!.name.length).toBeGreaterThan(0);
    }
    expect(arquivo.match(/BEGIN:VCARD/g)).toHaveLength(3);
    expect(arquivo.match(/END:VCARD/g)).toHaveLength(3);
  });

  it("tem FN, TEL e EMAIL — e TEL no formato que Android e iOS escrevem", () => {
    const cartao = vcardDoContato(BASE[0]!)!;
    expect(cartao).toContain("BEGIN:VCARD");
    expect(cartao).toContain("VERSION:3.0");
    expect(cartao).toContain("FN:Maria da Silva");
    expect(cartao).toContain("TEL;TYPE=CELL,VOICE:+5511999998888");
    expect(cartao).toContain("EMAIL;TYPE=INTERNET:maria@exemplo.com.br");
    expect(cartao).toContain("END:VCARD");
  });

  it("contato sem telefone ainda sai com FN + EMAIL; sem nada apresentável não sai", () => {
    const soEmail = vcardDoContato({ email: "sadez@exemplo.com.br" })!;
    expect(soEmail).toContain("FN:sadez@exemplo.com.br");
    expect(soEmail).not.toContain("TEL");
    expect(parseVcard(soEmail)!.name).toBe("sadez@exemplo.com.br");

    expect(vcardDoContato({ name: "", display_name: null, tags: ["x"] })).toBeNull();
    expect(vcardsDosContatos([{ name: "" }, BASE[0]!]).match(/BEGIN:VCARD/g)).toHaveLength(1);
  });

  it("quebra de linha no nome não parte o cartão", () => {
    const cartao = vcardDoContato({ name: "Maria\nSilva", phone_number: "+5511912345678" })!;
    // BEGIN, VERSION, FN, TEL, END + a quebra final que separa os cartões.
    expect(cartao.split("\n")).toHaveLength(6);
    expect(parseVcard(cartao)!.name).toBe("Maria Silva");
  });
});

describe("o nome do arquivo", () => {
  it("contatos-YYYY-MM-DD.ext — o mesmo formato do export de auditoria", () => {
    const hoje = new Date("2026-10-11T13:00:00.000Z");
    expect(nomeDoArquivo("csv", hoje)).toBe("contatos-2026-10-11.csv");
    expect(nomeDoArquivo("vcf", hoje)).toBe("contatos-2026-10-11.vcf");
  });
});

describe("a query do export é a da tela", () => {
  it("⭐ leva os filtros ativos e não leva cursor nem limite", () => {
    const qs = new URLSearchParams(
      queryDaExportacao("csv", {
        search: "maria silva",
        tags: ["vip", "orçamento"],
        tagMode: "ou",
        source: "whatsapp",
        pessoais: true,
        order_by: "display_name",
        order_dir: "asc",
      }),
    );

    expect(qs.get("formato")).toBe("csv");
    expect(qs.get("search")).toBe("maria silva");
    expect(qs.getAll("tag")).toEqual(["vip", "orçamento"]);
    expect(qs.get("modo")).toBe("ou");
    expect(qs.get("source")).toBe("whatsapp");
    expect(qs.get("pessoais")).toBe("true");
    expect(qs.get("order_by")).toBe("display_name");
    expect(qs.get("order_dir")).toBe("asc");
    expect(qs.has("cursor")).toBe(false);
    expect(qs.has("limit")).toBe(false);
  });

  it("o padrão não viaja: sem filtro não há parâmetro, e `e` não vira `modo=e`", () => {
    const qs = new URLSearchParams(queryDaExportacao("vcf", {}));
    expect([...qs.keys()].sort()).toEqual(["formato"]);
    expect(qs.get("formato")).toBe("vcf");

    const comUma = new URLSearchParams(queryDaExportacao("csv", { tags: ["vip"] }));
    expect(comUma.getAll("tag")).toEqual(["vip"]);
    expect(comUma.has("modo")).toBe(false);
    expect(comUma.has("pessoais")).toBe(false);
  });
});
