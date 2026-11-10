import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { IMPORT_MAX_DATA_ROWS, parseImportFile } from "@/lib/planilha/ler-arquivo";

function csv(texto: string): ArrayBuffer {
  const b = new TextEncoder().encode(texto);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** O Excel em português grava Latin-1 quando a pessoa escolhe "CSV (separado por ponto e vírgula)". */
function csvLatin1(texto: string): ArrayBuffer {
  const bytes = Uint8Array.from(texto, (ch) => ch.charCodeAt(0) & 0xff);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Um .xlsx de verdade é um zip de XMLs. Este monta o mínimo que o leitor abre: o `workbook.xml`
 * (a ordem das abas), o `workbook.xml.rels` (a que arquivo cada aba aponta) e a aba com as
 * células. `compartilhados` vira o `sharedStrings.xml`, que é como o Excel grava texto.
 */
function xlsx(opcoes: {
  abas: { nome: string; arquivo: string }[];
  celulas: (compartilhados: string[]) => string;
  compartilhados?: string[];
}): ArrayBuffer {
  const compartilhados = opcoes.compartilhados ?? [];
  const arquivos: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(
      `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${opcoes.abas
        .map((a, i) => `<sheet name="${a.nome}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${opcoes.abas
        .map((a, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/${a.arquivo}"/>`)
        .join("")}</Relationships>`,
    ),
  };
  for (const aba of opcoes.abas) {
    arquivos[`xl/worksheets/${aba.arquivo}`] = strToU8(opcoes.celulas(compartilhados));
  }
  if (compartilhados.length > 0) {
    arquivos["xl/sharedStrings.xml"] = strToU8(
      `<sst>${compartilhados.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`,
    );
  }
  const zipado = zipSync(arquivos);
  return zipado.buffer.slice(
    zipado.byteOffset,
    zipado.byteOffset + zipado.byteLength,
  ) as ArrayBuffer;
}

describe("parseImportFile — teto de linhas", () => {
  it("respeita maxLinhas e diz o teto efetivo na mensagem", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\nB;2\nC;3\n"), "lista.csv", {
      maxLinhas: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2");
  });

  it("aceita exatamente maxLinhas linhas de dados", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\nB;2\n"), "lista.csv", {
      maxLinhas: 2,
    });
    expect(r.ok).toBe(true);
  });

  it("sem opções o teto continua sendo o de 2.000 linhas", async () => {
    const corpo = (n: number) =>
      "empresa;telefone\n" + Array.from({ length: n }, (_, i) => `E${i};${i}`).join("\n") + "\n";
    expect(IMPORT_MAX_DATA_ROWS).toBe(2_000);
    expect((await parseImportFile(csv(corpo(2_000)), "lista.csv")).ok).toBe(true);
    const r = await parseImportFile(csv(corpo(2_001)), "lista.csv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2000");
  });
});

describe("parseImportFile — formato", () => {
  it("recusa .txt", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\n"), "lista.txt");
    expect(r).toEqual({ ok: false, error: "Formato não suportado — envie .csv ou .xlsx." });
  });
});

/**
 * OS DOIS SEPARADORES. A lista do operador vem do Excel em português (`;`) ou de uma exportação
 * de fora (`,`), com o mesmo cabeçalho — e é o mesmo arquivo depois. Um separador só na mesa
 * (o `;`) faz metade das listas chegarem como uma coluna única e o operador culpar a planilha.
 */
describe("parseImportFile — CSV com os dois separadores", () => {
  it("ponto e vírgula (Excel em português), com acento em UTF-8", async () => {
    const r = await parseImportFile(
      csv(
        "empresa;telefone;cidade\n" +
          "Padaria São João;(11) 99999-0000;São Paulo\n" +
          "Açougue Bom Preço;(11) 98888-0000;Campinas\n",
      ),
      "lista.csv",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.headers).toEqual(["empresa", "telefone", "cidade"]);
    expect(r.sheet.rows).toEqual([
      ["Padaria São João", "(11) 99999-0000", "São Paulo"],
      ["Açougue Bom Preço", "(11) 98888-0000", "Campinas"],
    ]);
  });

  it("vírgula, com vírgula DENTRO de aspas sem partir a linha", async () => {
    const r = await parseImportFile(
      csv(
        'empresa,telefone,endereco\n' +
          '"Padaria Um, Ltda",(11) 99999-0000,"Rua A, 10 - São Paulo"\n',
      ),
      "lista.csv",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.rows).toEqual([["Padaria Um, Ltda", "(11) 99999-0000", "Rua A, 10 - São Paulo"]]);
  });

  it("CSV em Latin-1 (o que o Excel grava ao escolher o separador) mantém o acento", async () => {
    const r = await parseImportFile(
      csvLatin1("empresa;telefone\nPadaria São João;(11) 99999-0000\n"),
      "lista.csv",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.rows[0]).toEqual(["Padaria São João", "(11) 99999-0000"]);
  });

  it("CSV com BOM (o que o Excel grava em UTF-8) não deixa BOM no nome da primeira coluna", async () => {
    const r = await parseImportFile(csv("\uFEFFempresa;telefone\nPadaria Um;(11) 99999-0000\n"), "lista.csv");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.headers[0]).toBe("empresa");
  });
});

/**
 * O XLSX. O caminho real do operador é "salvei do Excel": nenhuma exportação entrega CSV, e o
 * leitor aqui é um zip de XML — o que se prova é que a PRIMEIRA aba (na ordem das abas, que não
 * é o nome do arquivo) vira cabeçalho + linhas, com texto compartilhado, célula vazia no meio e
 * telefone gravado como NÚMERO (o Excel converte 11999990000 em número sem avisar).
 */
describe("parseImportFile — XLSX", () => {
  it("lê a primeira aba na ordem das abas, com texto compartilhado e número", async () => {
    const r = await parseImportFile(
      xlsx({
        abas: [
          { nome: "Lista", arquivo: "sheet2.xml" },
          { nome: "Ignorada", arquivo: "sheet1.xml" },
        ],
        compartilhados: ["Empresa", "Telefone", "Site", "Padaria Um"],
        celulas: () =>
          "<sheetData>" +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>11999990000</v></c><c r="C2"/></row>' +
          "</sheetData>",
      }),
      "lista.xlsx",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet.headers).toEqual(["Empresa", "Telefone", "Site"]);
    // A célula vazia no fim e o número do telefone chegam como texto, do jeito que o parser
    // de prospecção espera (ele normaliza para E.164 depois).
    expect(r.sheet.rows).toEqual([["Padaria Um", "11999990000", ""]]);
  });

  it("um xlsx sem abas legíveis não vira planilha vazia silenciosa", async () => {
    const r = await parseImportFile(
      xlsx({ abas: [{ nome: "Lista", arquivo: "sheet1.xml" }], celulas: () => "<sheetData/>" }),
      "lista.xlsx",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cabeçalho");
  });
});
