import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lerPlanilha } from "@/lib/catalogo/planilha";
import { decodificarCsv } from "@/lib/contacts/csv";

/**
 * A PLANILHA QUE SAIU DO EXCEL EM LATIN-1 NÃO ENTRA CORROMPIDA (issue #483).
 *
 * ─── O defeito, medido no HEAD c5b45b24 ─────────────────────────────────────
 *
 * As duas rotas de importação liam o arquivo com `await file.text()`, que
 * decodifica SEMPRE como UTF-8. O Excel em português exporta cp1252 por padrão,
 * e o desfecho dependia de onde estava o acento:
 *
 *   acento nos DADOS      -> IMPORTAVA, com o nome corrompido:
 *                            nome = "A��o C�nica �"
 *   acento no CABEÇALHO   -> 422: "A planilha precisa de uma coluna de preço.
 *                            Encontrei: C�digo, Produto, Pre�o, Marca."
 *
 * O primeiro é o grave: falha ABERTA. A tela diz "N produtos importados", o
 * catálogo fica com lixo, e é esse nome que o agente lê para o cliente.
 *
 * ─── Por que o desempate é "tem U+FFFD?" e não uma detecção de charset ──────
 *
 * `TextDecoder("utf-8")` só produz U+FFFD quando o byte-stream NÃO é UTF-8
 * válido. Então a ausência de U+FFFD é prova de que UTF-8 é a leitura certa, e
 * a presença é prova de que não é. Não há adivinhação no caso comum.
 *
 * ─── O que este conserto NÃO alcança (escreva antes de alguém supor) ────────
 *
 * O mojibake da ORIGEM — "AÃ§Ã£o", que é UTF-8 já gravado como latin-1 pelo
 * sistema que gerou a planilha — é UTF-8 válido, não tem U+FFFD nenhum, e passa
 * limpo pelo desempate. Ele continua entrando. É outro defeito, com outra
 * evidência, e resolvê-lo exige heurística de plausibilidade que esta não tem.
 */

const cp1252 = (texto: string) => Buffer.from(texto, "latin1");
const bytes = (b: number[]) => Buffer.from(b);

/** O caminho de produção inteiro, sem HTTP: decodifica os bytes, depois lê. */
function importar(buf: Buffer): ReturnType<typeof lerPlanilha> {
  const d = decodificarCsv(buf);
  if ("erro" in d) return { erro: d.erro };
  return lerPlanilha(d.texto);
}

describe("bytes cp1252 do Excel pt-BR", () => {
  it("acento nos DADOS chega ao catálogo inteiro, não corrompido", () => {
    // Era o caso que falhava ABERTO: importava com "A��o C�nica �".
    const r = importar(cp1252("codigo,produto,preco\nA1,Ação Cônica Ç,5499,00\n"));

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(1);
    // Igualdade, não `toMatch`: um sufixo de lixo colado passaria numa busca.
    expect(r.produtos[0]?.nome).toBe("Ação Cônica Ç");
    expect(r.produtos[0]?.nome).not.toContain("�");
  });

  it("acento no CABEÇALHO deixa de recusar o arquivo", () => {
    // Era 422 com a mensagem ilegível — o arquivo inteiro morria na borda.
    const r = importar(cp1252("Código;Produto;Preço;Marca\nIP15;iPhone 15;R$ 5.499,00;Apple\n"));

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0]?.preco_cents).toBe(549900);
    expect(r.produtos[0]?.codigo).toBe("IP15");
    expect(r.colunasIgnoradas).toEqual([]);
  });

  it("o acento sobrevive também no que NÃO é o nome", () => {
    const r = importar(cp1252("nome,preco,marca,categoria\nFone,199,Genérico,Áudio\n"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.marca).toBe("Genérico");
    expect(r.produtos[0]?.categoria).toBe("Áudio");
  });
});

describe("o que não é texto é RECUSADO, nunca adivinhado", () => {
  it("arquivo binário renomeado para .csv vira erro de arquivo", () => {
    // Assinatura de .xlsx (PK\x03\x04) + bytes altos: o utf-8 falha, e o
    // windows-1252 "consegue" ler qualquer byte — se ninguém olhasse o
    // resultado, este arquivo viraria produtos de nome ilegível.
    const r = decodificarCsv(bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xe7, 0x9c, 0xff]));

    expect("erro" in r).toBe(true);
    if (!("erro" in r)) return;
    expect(r.erro).toContain("CSV UTF-8");
  });

  it("tabulação, CR e LF continuam sendo texto", () => {
    // O guarda mira byte de controle, e TAB é delimitador legítimo aqui.
    const r = decodificarCsv(cp1252("nome\tpreço\r\nCafé\t9,90\r\n"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.texto).toBe("nome\tpreço\r\nCafé\t9,90\r\n");
  });
});

describe("o arquivo que já estava certo não muda", () => {
  it("UTF-8 continua UTF-8", () => {
    const r = importar(Buffer.from("nome,preco\nAção Cônica Ç,5499,00\n", "utf8"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.nome).toBe("Ação Cônica Ç");
  });

  it("BOM de UTF-8 não vira coluna fantasma", () => {
    const r = importar(Buffer.from("﻿nome,preco\nCafé,9,90\n", "utf8"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(1);
    expect(r.produtos[0]?.nome).toBe("Café");
  });
});

/**
 * O guarda acima mede a FUNÇÃO. Sem este, consertar a função e deixar a rota
 * chamando `file.text()` passaria verde — que é exatamente o estado de hoje.
 */
describe("as rotas de importação decodificam pelos BYTES", () => {
  const ROTAS = [
    "app/api/v1/products/import/route.ts",
    "app/api/v1/contacts/import/route.ts",
  ] as const;

  /** Comentário é prosa: um `file.text()` CITADO num comentário não é chamada. */
  const semComentarios = (fonte: string) =>
    fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it.each(ROTAS)("%s não lê o upload com .text()", (rota) => {
    const codigo = semComentarios(readFileSync(join(process.cwd(), rota), "utf8"));

    // Booleano em vez do texto inteiro: o diff de um `toContain` sobre um
    // arquivo de 200 linhas enterra o motivo da falha.
    expect(codigo.includes("decodificarCsv(")).toBe(true);
    // `req.text()` de webhook é outra coisa; o que não pode é o ARQUIVO.
    expect(/\b(arquivo|file)\.text\(\)/.test(codigo)).toBe(false);
  });

  it("o guarda enxerga a chamada quando ela existe (controle positivo)", () => {
    // Sem isto, "não achei `file.text()`" poderia ser sonda cega em vez de
    // ausência: a mesma sonda tem de ACHAR num código que a contém.
    const comDefeito = "const t = await file.text();\n// decodificarCsv(bytes)\n";

    expect(/\b(arquivo|file)\.text\(\)/.test(semComentarios(comDefeito))).toBe(true);
    expect(semComentarios(comDefeito).includes("decodificarCsv(")).toBe(false);
  });
});

describe("um byte ruim não condena o arquivo inteiro", () => {
  /**
   * ⚠️ REGRESSÃO MEDIDA depois do merge, numa varredura adversarial dos próprios
   * merges do dia. O desempate original era `if (utf8.includes("\uFFFD"))` —
   * decisão por ARQUIVO tomada sobre um sinal por BYTE, sem proporção.
   *
   * Um único byte inválido no meio de um arquivo perfeitamente UTF-8 (0x92, a
   * aspa curva do Word, sobra comum de copiar-colar) jogava TODAS as linhas para
   * o windows-1252. Medido com esta mesma função:
   *
   *   arquivo limpo          → "Ação" corretos=500  mojibake=  0
   *   + 1 byte 0x92 no meio  → "Ação" corretos=  0  mojibake=500
   *
   * E o caminho anterior ao conserto (`file.text()`, UTF-8 com substituição
   * local) era MELHOR nesse caso: corrompia UM caractere, não o arquivo. O
   * `upsert` por `(organization_id, codigo)` ainda sobrescrevia os nomes bons
   * que já estavam no catálogo — com `erros: []` e 200 OK.
   */
  const cemLinhas = Array.from({ length: 100 }, (_, i) => `Ação Cônica nº ${i + 1}`).join("\n");

  it("UTF-8 com UM byte inválido continua sendo lido como UTF-8", () => {
    const limpo = Buffer.from(cemLinhas, "utf8");
    const meio = Math.floor(limpo.length / 2);
    const sujo = Buffer.concat([limpo.subarray(0, meio), Buffer.from([0x92]), limpo.subarray(meio)]);

    const r = decodificarCsv(new Uint8Array(sujo));
    const texto = "texto" in r ? r.texto : "";
    expect(
      (texto.match(/Ação/g) ?? []).length,
      "um byte solto derrubou o arquivo inteiro para windows-1252 — a decisão " +
        "por arquivo voltou a ser tomada sobre um sinal por byte",
    ).toBeGreaterThanOrEqual(99);
    expect((texto.match(/AÃ§/g) ?? []).length, "mojibake em massa").toBe(0);
  });

  it("latin-1 de verdade CONTINUA sendo detectado — o par do «não faça X»", () => {
    // Sem este caso, "sempre devolva UTF-8" satisfaria o de cima e desfaria o
    // conserto que este arquivo inteiro existe para guardar.
    const latin = Buffer.from(cemLinhas, "latin1");
    const r = decodificarCsv(new Uint8Array(latin));
    const texto = "texto" in r ? r.texto : "";
    expect(
      (texto.match(/Ação/g) ?? []).length,
      "latin-1 puro deixou de ser detectado — o conserto original foi desfeito",
    ).toBeGreaterThanOrEqual(99);
  });

  it("a densidade separa as duas causas por ordens de grandeza — o porquê do número", () => {
    // Documenta a folga que sustenta MAX_BYTES_POR_SUBSTITUICAO: se um dia as
    // duas se aproximarem, este caso avisa antes de alguém descobrir na planilha
    // de um cliente.
    const conta = (b: Buffer) => {
      const d = new TextDecoder("utf-8").decode(b);
      const n = (d.match(/\uFFFD/g) ?? []).length;
      return n === 0 ? Infinity : b.byteLength / n;
    };
    const limpo = Buffer.from(cemLinhas, "utf8");
    const meio = Math.floor(limpo.length / 2);
    const sujo = Buffer.concat([limpo.subarray(0, meio), Buffer.from([0x92]), limpo.subarray(meio)]);

    expect(conta(Buffer.from(cemLinhas, "latin1")), "latin-1 real ficou esparso demais").toBeLessThan(50);
    expect(conta(sujo), "um byte ruim ficou denso demais").toBeGreaterThan(500);
  });
});
