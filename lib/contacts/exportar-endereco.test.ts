/**
 * A EXPORTAÇÃO LEVA O ENDEREÇO DO CONTATO (#3494).
 *
 * O CSV é o MESMO formato que a tela importa, e o contrato do arquivo é
 * declarado em `lib/contacts/exportar.ts`: as colunas de cá são exatamente as
 * que o importer de lá reconhece. Guardar rua, bairro, cidade e CEP no contato
 * e não levá-los no arquivo de saída faria backup, mudança de instalação e
 * pedido de portabilidade (LGPD art. 18, V) devolverem a metade do contato que
 * não serve para entrega nem cobrança.
 *
 * Nada aqui é conferido contra expectativa escrita à mão: o CSV passa pelo
 * caminho EXATO do import (`parseCsv` + `mapHeader` + `mapLinha`) e o vCard
 * pelo reader do produto (`parseVcard`, #2712). Se o round-trip deixar de
 * fechar — inclusive para o endereço —, este arquivo fica vermelho.
 */
import { describe, expect, it } from "vitest";

import { mapHeader, mapLinha, parseCsv } from "@/lib/contacts/csv";
import {
  CABECALHO_DO_CSV,
  COLUNAS_DO_CSV,
  csvDosContatos,
  vcardDoContato,
  type ContatoParaExportar,
} from "@/lib/contacts/exportar";
import { parseVcard } from "@/lib/messaging/contact-card";

const ENDERECO: ContatoParaExportar = {
  name: "Ana Souza",
  phone_number: "+5541999991200",
  email: "ana@exemplo.com.br",
  zip_code: "80000-000",
  street: "Rua XV de Novembro",
  number: "120",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

const SETE_COLUNAS = [
  "zip_code",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
] as const;

function reimporta(csv: string): Array<Record<string, string | string[] | undefined>> {
  const rows = parseCsv(csv);
  const mapeado = mapHeader(rows[0]!);
  expect(mapeado.motivo, "o cabeçalho exportado tem de ser aceito pelo import").toBeNull();
  return rows.slice(1).map((celulas) => {
    const { contato, motivo } = mapLinha(celulas, mapeado.indices);
    expect(motivo, `linha recusada pelo import: ${motivo}`).toBeNull();
    return contato as Record<string, string | string[] | undefined>;
  });
}

describe("o CSV leva o endereço, e o import o devolve", () => {
  it("as sete colunas de endereço saem no cabeçalho, com o nome da coluna do banco", () => {
    for (const coluna of SETE_COLUNAS) {
      expect(COLUNAS_DO_CSV).toContain(coluna);
      expect(CABECALHO_DO_CSV.split(",")).toContain(coluna);
    }
    // O cabeçalho não ganhou NENHUMA coluna que o importer não leia.
    const mapeado = mapHeader(CABECALHO_DO_CSV.split(","));
    expect(Object.keys(mapeado.indices).sort()).toEqual([...COLUNAS_DO_CSV].sort());
  });

  it("⭐ round-trip: exportar e reimportar devolve os sete campos do endereço", () => {
    const [linha] = reimporta(csvDosContatos([ENDERECO]));

    expect(linha).toMatchObject({
      name: "Ana Souza",
      phone_number: "+5541999991200",
      zip_code: "80000-000",
      street: "Rua XV de Novembro",
      number: "120",
      complement: "apto 42",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    });
  });

  it("contato sem endereço continua exportando: as sete colunas saem vazias, não ausentes do cabeçalho", () => {
    const csv = csvDosContatos([{ name: "Sem Endereço", phone_number: "+5511999990000" }]);
    const cabecalho = parseCsv(csv)[0]!;

    for (const coluna of SETE_COLUNAS) expect(cabecalho).toContain(coluna);

    const [linha] = reimporta(csv);
    for (const coluna of SETE_COLUNAS) expect(linha![coluna]).toBeUndefined();
  });

  it("o vCard leva o ADR com rua, número, bairro, cidade, UF e CEP", () => {
    const cartao = vcardDoContato(ENDERECO)!;

    expect(cartao).toContain("ADR;TYPE=HOME:;apto 42 - Centro;Rua XV de Novembro, 120;Curitiba;PR;80000-000;");
    // O bairro não tem componente próprio no vCard 3.0: divide o "complemento"
    // do formato com o complemento do imóvel, em vez de se perder.
    expect(cartao).toContain("apto 42 - Centro");
    // E o reader do próprio produto continua lendo o cartão.
    expect(parseVcard(cartao)).toMatchObject({ name: "Ana Souza" });
  });

  it("contato sem endereço não emite ADR vazio — o celular mostraria um endereço em branco", () => {
    const cartao = vcardDoContato({ name: "Sem Endereço", phone_number: "+5511999990000" })!;

    expect(cartao).not.toContain("ADR");
  });
});
