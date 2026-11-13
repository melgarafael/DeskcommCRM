import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { parseImportFile } from "@/lib/crm-b2b/spreadsheet";

/**
 * O leitor de XLSX é código nosso (fflate + o mínimo do formato), então quem
 * prova que ele lê uma planilha de verdade é este arquivo. O `.xlsx` é montado
 * aqui do jeito que o Excel grava: a primeira aba NÃO é `sheet1.xml` (abas
 * reordenadas), texto compartilhado com entidade e texto rico, célula pulada no
 * meio da linha, CNPJ digitado como número, e linha vazia.
 */
function xlsx(partes: Record<string, string>): ArrayBuffer {
  const zip = zipSync(Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, strToU8(v)])));
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
<sheet name="Leads" sheetId="2" r:id="rId2"/><sheet name="Outra" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships>
<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
const COMPARTILHADOS = `<?xml version="1.0"?><sst><si><t>Empresa</t></si><si><t>CNPJ</t></si><si><t>Pessoa</t></si>
<si><t>Telefone</t></si><si><t>Silva &amp; Filhos</t></si><si><r><t>Jos</t></r><r><t xml:space="preserve">é Silva</t></r></si></sst>`;
const ABA_CERTA = `<?xml version="1.0"?><worksheet><cols><col min="1" max="4"/></cols><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>1.1222333000181E+13</v></c><c r="C2" t="s"><v>5</v></c><c r="D2" t="inlineStr"><is><t>(85) 99999-1111</t></is></c></row>
<row r="3"/>
<row r="4"><c r="A4" t="inlineStr"><is><t>Só a empresa</t></is></c><c r="B4" s="1"/></row>
</sheetData></worksheet>`;
const ABA_ERRADA = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>não sou a primeira aba</t></is></c></row></sheetData></worksheet>`;

describe("parseImportFile — XLSX", () => {
  it("lê a primeira aba pela ordem do workbook, com texto compartilhado, rico e inline", async () => {
    const r = await parseImportFile(
      xlsx({
        "xl/workbook.xml": WORKBOOK,
        "xl/_rels/workbook.xml.rels": RELS,
        "xl/sharedStrings.xml": COMPARTILHADOS,
        "xl/worksheets/sheet1.xml": ABA_ERRADA,
        "xl/worksheets/sheet2.xml": ABA_CERTA,
      }),
      "clientes.xlsx",
    );
    expect(r).toEqual({
      ok: true,
      sheet: {
        headers: ["Empresa", "CNPJ", "Pessoa", "Telefone"],
        rows: [
          ["Silva & Filhos", "11222333000181", "José Silva", "(85) 99999-1111"],
          ["Só a empresa", "", "", ""],
        ],
        rowNumbers: [2, 4],
      },
    });
  });

  it("zip que não é planilha e .xls antigo são recusados com mensagem, sem lançar", async () => {
    const naoPlanilha = await parseImportFile(xlsx({ "leia-me.txt": "oi" }), "x.xlsx");
    expect(naoPlanilha.ok).toBe(false);
    const lixo = await parseImportFile(strToU8("não é zip").buffer as ArrayBuffer, "x.xlsx");
    expect(lixo).toEqual({ ok: false, error: "Não consegui ler o arquivo XLSX." });
    const xls = await parseImportFile(new ArrayBuffer(10), "antigo.xls");
    expect(xls).toEqual({ ok: false, error: "Formato não suportado — envie .csv ou .xlsx." });
  });

  it("CSV continua pelo parser dos contatos (Excel em português, com `;`)", async () => {
    const r = await parseImportFile(strToU8("Empresa;CNPJ\nACME;11.222.333/0001-81\n").buffer as ArrayBuffer, "a.csv");
    expect(r).toEqual({
      ok: true,
      sheet: {
        headers: ["Empresa", "CNPJ"],
        rows: [["ACME", "11.222.333/0001-81"]],
        rowNumbers: [2],
      },
    });
  });
});
