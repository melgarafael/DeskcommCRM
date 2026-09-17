// @vitest-environment node
//
// O MATERIAL DO ACERVO SALVO EM CP1252 NÃO ENTRA CORROMPIDO (issue #531).
//
// O defeito, medido no HEAD 5c132f4d:
//
// `extractMarkdownText` (`lib/ai/rag/extractors/markdown.ts`) fazia
// `buffer.toString("utf8")` em tudo, e é o caminho do upload do acervo
// (`app/api/v1/ai/knowledge/sources/upload/route.ts` → `extrairTextoDoArquivo`
// → ele). O Bloco de Notas salva em cp1252 por padrão — que é como quem monta
// base de conhecimento no Windows escreve o `.txt` — e o desfecho era falha
// ABERTA: nenhum erro, nenhum aviso, o material nascia "pronto" com cada acento
// trocado por U+FFFD, e é esse texto que o agente cita para o cliente.
//
//     entrava:  "Pol�tica de troca: devolu��o em at� 7 dias corridos.
//                A��o, cora��o, cabe�a e av�."
//     sai agora: "Política de troca: devolução em até 7 dias corridos.
//                Ação, coração, cabeça e avô."
//
// Sem o conserto, 4 dos 7 casos deste arquivo ficam vermelhos — os dois de
// cp1252 e os dois de recusa. Os três que já entravam certo continuam verdes: é
// o par que impede o "conserto" preguiçoso de ler tudo como windows-1252, que
// estragaria em massa justamente os arquivos UTF-8.
//
// ─── Por que o conserto é o MESMO do #483, e não um novo ────────────────────
//
// O desempate de codificação já existia em `lib/contacts/csv.ts`: lê como
// UTF-8, e só troca para o windows-1252 quando a DENSIDADE de U+FFFD prova que
// o arquivo não é UTF-8 (os números e a folga do limiar estão lá). Aqui não há
// segunda regra, há a mesma função — `decodificarBytesDeTexto` — com o segundo
// chamador que ela passou a ter. Duas regras de charset seriam duas respostas
// para a mesma pergunta, e a que ninguém lembrar de atualizar é a que envelhece.
//
// ─── O que este arquivo NÃO mede (escrito para ninguém supor) ───────────────
//
// - A rota HTTP inteira: o teste entra por `extrairTextoDoArquivo`, que é a
//   função que a rota chama (`route.ts:155`). O 422 que ela produz a partir de
//   `ErroDeExtracao` é fiação já existente e coberta no `ai-knowledge-sources-post`.
// - O mojibake da ORIGEM ("AÃ§Ã£o" já gravado por quem gerou o arquivo): é
//   UTF-8 válido, não tem U+FFFD, e continua entrando. É outro defeito, com
//   outra prova — está declarado no comentário de `decodificarBytesDeTexto`.
// - UTF-16 só de ASCII (sem acento): passa como texto, com NUL no meio. Mesma
//   lacuna da regra do #483, declarada lá.

import { describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { ErroDeExtracao, extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

/** O que o Bloco de Notas grava em cp1252 — latin1 byte a byte para os acentos. */
const cp1252 = (texto: string) => Buffer.from(texto, "latin1");

/** Copia exata dos bytes, sem depender do pool de memória do Node. */
function bytesExatos(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Dubla o download do Storage devolvendo os BYTES deste arquivo. É o único
 * ponto de I/O do caminho de extração — o resto (extensão → decoder → texto) é
 * código de produção.
 */
function servindo(bytes: Buffer): void {
  const download = vi.fn(async () => ({ data: new Blob([bytesExatos(bytes)]), error: null }));
  vi.mocked(createAdminClient).mockReturnValue({
    storage: { from: () => ({ download }) },
  } as unknown as ReturnType<typeof createAdminClient>);
}

describe("o material do acervo salvo em cp1252", () => {
  it("o .txt do Bloco de Notas entra com o acento inteiro, não com mojibake", async () => {
    const original =
      "Política de troca: devolução em até 7 dias corridos.\nAção, coração, cabeça e avô.\n";
    servindo(cp1252(original));

    const { texto } = await extrairTextoDoArquivo("org/material.txt", "txt");

    // Igualdade, não `toMatch`: um sufixo de lixo colado passaria numa busca.
    expect(texto).toBe(original.trim());
    expect(texto, "o U+FFFD sobrou no texto que o agente lê").not.toContain("\uFFFD");
    expect(texto, "o acento entrou como mojibake").not.toContain("Ã");
  });

  it("o .md em cp1252 entra com o corpo acentuado e sem o frontmatter", async () => {
    const original = "---\ntitulo: Política de devolução\n---\n\nAção de troca: até 7 dias.\n";
    servindo(cp1252(original));

    const { texto, extensao } = await extrairTextoDoArquivo("org/material.md", "md");

    expect(extensao).toBe("md");
    expect(texto).toBe("Ação de troca: até 7 dias.");
    expect(texto).not.toContain("Ã");
  });
});

describe("o que já entrava certo continua entrando igual", () => {
  it("UTF-8 continua UTF-8", async () => {
    const original = "Política de troca: devolução em até 7 dias.\n";
    servindo(Buffer.from(original, "utf8"));

    const { texto } = await extrairTextoDoArquivo("org/material.txt", "txt");

    expect(texto).toBe(original.trim());
  });

  it("um byte ruim no meio NÃO condena o arquivo inteiro (a densidade do #483 vale aqui também)", async () => {
    // 0x92 é a aspa curva do Word em cp1252 e um byte inválido em UTF-8. Decidir
    // por ARQUIVO sobre um sinal por BYTE é a regressão que o #483 pagou caro:
    // 500 linhas boas viravam mojibake por causa de um caractere.
    const cemLinhas = Array.from({ length: 100 }, (_, i) => `Ação Cônica nº ${i + 1}`).join("\n");
    const limpo = Buffer.from(cemLinhas, "utf8");
    const meio = Math.floor(limpo.length / 2);
    servindo(
      Buffer.concat([limpo.subarray(0, meio), Buffer.from([0x92]), limpo.subarray(meio)]),
    );

    const { texto } = await extrairTextoDoArquivo("org/material.txt", "txt");

    expect(
      (texto.match(/Ação/g) ?? []).length,
      "um byte solto derrubou o material inteiro para windows-1252",
    ).toBeGreaterThanOrEqual(99);
    expect((texto.match(/AÃ§/g) ?? []).length, "mojibake em massa").toBe(0);
  });

  it("o BOM de UTF-8 não vira caractere no começo do texto", async () => {
    servindo(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Ação\n", "utf8")]));

    const { texto } = await extrairTextoDoArquivo("org/material.md", "md");

    expect(texto).toBe("Ação");
  });
});

describe("o que não é texto é RECUSADO, nunca indexado como lixo", () => {
  it("o binário renomeado para .md vira erro de extração, não material ilegível", async () => {
    // Assinatura de .xlsx (PK\x03\x04) + byte alto: o utf-8 falha e o
    // windows-1252 "consegue" ler qualquer byte — sem a recusa, este arquivo
    // entra no acervo como trechos que o agente cita.
    servindo(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xe7, 0x9c, 0xff]));

    await expect(extrairTextoDoArquivo("org/planilha.md", "md")).rejects.toBeInstanceOf(
      ErroDeExtracao,
    );
    await expect(extrairTextoDoArquivo("org/planilha.md", "md")).rejects.toThrow(
      /não consegui ler este arquivo como texto/,
    );
  });

  it("o .txt salvo em UTF-16 pelo Bloco de Notas também é recusado", async () => {
    // O "Unicode" do Bloco de Notas é UTF-16LE com BOM: letra, NUL, letra, NUL.
    // Com acento (í) há byte alto — e o NUL que sobra na leitura prova que não é
    // texto desta codificação.
    servindo(Buffer.from("\uFEFFPolítica de troca: ação em até 7 dias.\n", "utf16le"));

    await expect(extrairTextoDoArquivo("org/material.txt", "txt")).rejects.toBeInstanceOf(
      ErroDeExtracao,
    );
  });
});
