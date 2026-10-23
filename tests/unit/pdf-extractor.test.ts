// @vitest-environment node
//
// Issue #102. Este arquivo nasceu porque `extractPdfText` estava mockado em TODOS
// os testes que o tocavam (`extractPdf: vi.fn(...)` em media-derive.test.ts), então
// nenhuma linha de pdfjs era executada pelo CI. A extração ficou quebrada por um
// `GlobalWorkerOptions.workerSrc = ""` e o CI seguiu verde o tempo todo.
//
// Issue #238. O arquivo tinha um teste "cai no fallback do pdf-parse", e ele não
// media o que dizia medir: o pdf-parse@1 falha com "bad XRef entry" na fixture
// `sample-text.pdf` deste repo, então o caminho primário JÁ estava morto e quem
// extraía era o fallback — nos dois testes. Hoje há uma engine só (pdfjs-dist), e
// as asserções abaixo são de igualdade EXATA de propósito: é isso que faz uma troca
// de engine, ou de estratégia de junção de linhas, ficar vermelha aqui.
//
// As fixtures são PDFs 1.4 escritos à mão (texto puro, `cat`-áveis), sem compressão
// e sem gerador — determinísticas byte a byte.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const raiz = process.cwd();
const fixture = (nome: string) => readFileSync(join(raiz, "tests/fixtures", nome));

afterEach(() => {
  vi.resetModules();
});

describe("extractPdfText", () => {
  it("extrai texto de um PDF real", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-text.pdf"))).toBe("DeskcommCRM RAG fixture");
  });

  it("preserva a acentuação do português", async () => {
    // Acentuação é o primeiro lugar onde uma troca de engine estraga texto sem
    // quebrar teste nenhum — o PDF codifica em WinAnsi e alguém tem de decodificar.
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-acentos.pdf"))).toBe(
      "Ação de vendas: café, órgão, três.",
    );
  });

  it("preserva quebra de linha dentro da página e separa páginas por linha em branco", async () => {
    // O chunker do RAG corta por estrutura; se a extração achatar tudo numa linha só,
    // o texto continua "certo" e a recuperação piora em silêncio.
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    expect(await extractPdfText(fixture("sample-multipagina.pdf"))).toBe(
      "Pagina um linha um\nPagina um linha dois\n\nPagina dois linha um\nPagina dois linha dois",
    );
  });

  it("lança PdfExtractError quando o PDF é válido mas não tem texto algum", async () => {
    // O caso "PDF digitalizado / só imagem": a fixture abre sem erro nenhum, tem uma
    // página e zero itens de texto. É o único caminho em que a engine trabalha até o
    // fim e mesmo assim não há o que ingerir — sem esta fixture, a guarda de texto
    // vazio não é exercitada por teste nenhum.
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-sem-texto.pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
    await expect(extractPdfText(fixture("sample-sem-texto.pdf"))).rejects.toThrow(/image-only/);
  });

  it("lança PdfExtractError quando o buffer não é PDF", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(Buffer.from("isto não é um pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("lança PdfExtractError quando o PDF tem cabeçalho válido mas corpo corrompido", async () => {
    // Pior que o buffer aleatório: começa com %PDF-, então passa por qualquer
    // checagem de assinatura e só morre dentro da engine.
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-corrompido.pdf"))).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("diz o que fazer quando o binário nativo do canvas falta", async () => {
    // O pdfjs 6 estoura no import sem @napi-rs/canvas. Sem esta tradução o
    // self-hoster vê "DOMMatrix is not defined" e não tem como ligar isso a uma
    // dependência opcional que ele nem sabe que existe.
    //
    // Na VPS o erro nasce no IMPORT do módulo. Aqui ele nasce no getDocument, e é
    // fiel ao que importa: o branch decide pela MENSAGEM, não pelo ponto de origem.
    // (Mockar o factory para lançar não serve — o vitest reembrulha e a mensagem some.)
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      GlobalWorkerOptions: {},
      getDocument: () => {
        throw new Error("DOMMatrix is not defined");
      },
    }));
    vi.resetModules();

    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-text.pdf"))).rejects.toThrow(PdfExtractError);
    await expect(extractPdfText(fixture("sample-text.pdf"))).rejects.toThrow(/@napi-rs\/canvas/);
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  });

  it("tem uma engine só: pdf-parse não volta como dependência", async () => {
    // O pdf-parse@1 carrega 29 MB de pdf.js vendorizado (quatro cópias) e fixa a de
    // 2018 — 7 majors atrás da que já está aqui. Isso é peso na imagem Docker do
    // self-host em troca de uma engine PIOR. Se alguém readicionar, este teste conta.
    const pkg = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const todas = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(todas)).not.toContain("pdf-parse");
    expect(Object.keys(todas)).not.toContain("@types/pdf-parse");
  });
});

/**
 * A SEGUNDA ESTRATÉGIA É A MESMA ENGINE NOUTRO PROCESSO.
 *
 * Medido na imagem `deskcomm-worker:1.27.1`: sob `tsx`, extrair a fixture de
 * 1 KB custa 117 MB de heap (o tsx transforma `pdf.mjs` + `pdf.worker.mjs`
 * inteiros); em `node` puro, 19 MB. Um PDF real de 18 KB passava dos 227 MB e
 * matava o worker (`heap limit`) — 313 reinícios em 2026-09-15.
 *
 * O que se prende aqui: (1) o texto é IDÊNTICO nas duas estratégias, byte a
 * byte, em todas as fixtures — é o que vigia a duplicação do laço de páginas
 * dentro do script do filho; (2) o filho que morre vira `PdfExtractError`
 * comum, e o processo pai sobrevive — é o isolamento que o worker não tinha;
 * (3) sob o `tsx` de verdade a estratégia padrão é a do filho, e o heap do pai
 * fica longe do que era.
 */
describe("extractPdfText — estratégia `processo-a-parte`", () => {
  const A_PARTE = { estrategia: "processo-a-parte" as const };

  it.each(["sample-text.pdf", "sample-acentos.pdf", "sample-multipagina.pdf"])(
    "devolve o MESMO texto que a extração em processo: %s",
    async (nome) => {
      const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
      const emProcesso = await extractPdfText(fixture(nome), { estrategia: "em-processo" });
      const aParte = await extractPdfText(fixture(nome), A_PARTE);
      expect(aParte).toBe(emProcesso);
    },
  );

  it("PDF sem texto e PDF corrompido falham com PdfExtractError, como em processo", async () => {
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(extractPdfText(fixture("sample-sem-texto.pdf"), A_PARTE)).rejects.toThrow(
      /image-only/,
    );
    await expect(extractPdfText(fixture("sample-corrompido.pdf"), A_PARTE)).rejects.toBeInstanceOf(
      PdfExtractError,
    );
    await expect(extractPdfText(Buffer.from("isto não é um pdf"), A_PARTE)).rejects.toBeInstanceOf(
      PdfExtractError,
    );
  });

  it("o filho que estoura o heap vira um erro comum, e o pai sobrevive", async () => {
    // Um teto de 4 MB não abre nem o pdfjs. Antes, isto era o worker inteiro
    // caindo com `FATAL ERROR: Reached heap limit`; agora é um `PdfExtractError`
    // que o handler devolve como erro, e o dreno conta a tentativa.
    const { extractPdfText, PdfExtractError } = await import("@/lib/ai/rag/extractors/pdf");
    const erro = await extractPdfText(fixture("sample-multipagina.pdf"), {
      ...A_PARTE,
      heapMb: 4,
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PdfExtractError);
    // A frase diz COMO morreu e com QUE teto — é o `last_error` que distingue
    // PDF grande demais de PDF corrompido.
    expect((erro as Error).message).toMatch(/sem responder/);
    expect((erro as Error).message).toMatch(/teto de heap 4 MB/);
    // O pai continua vivo e extraindo.
    expect(await extractPdfText(fixture("sample-text.pdf"), A_PARTE)).toBe("DeskcommCRM RAG fixture");
  });

  it("o filho que não responde a tempo é morto e vira PdfExtractError", async () => {
    const { extractPdfText } = await import("@/lib/ai/rag/extractors/pdf");
    await expect(
      extractPdfText(fixture("sample-multipagina.pdf"), { ...A_PARTE, timeoutMs: 1 }),
    ).rejects.toThrow(/excedeu 1 ms/);
  });

  it("a estratégia padrão é a do filho SÓ sob o tsx", async () => {
    const { estrategiaPadrao } = await import("@/lib/ai/rag/extractors/pdf");
    // O que `process.execArgv` traz dentro da imagem do worker, medido.
    expect(
      estrategiaPadrao([
        "--require",
        "/app/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/preflight.cjs",
        "--import",
        "file:///app/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs",
      ]),
    ).toBe("processo-a-parte");
    // O hook pelo especificador cru — a forma do CMD desde o #2823.
    expect(estrategiaPadrao(["--import", "tsx"])).toBe("processo-a-parte");
    expect(estrategiaPadrao(["--import=tsx"])).toBe("processo-a-parte");
    expect(estrategiaPadrao(["--import", "tsx/esm"])).toBe("processo-a-parte");
    // App Next, vitest, node puro: nada muda.
    expect(estrategiaPadrao([])).toBe("em-processo");
    expect(estrategiaPadrao(["--max-old-space-size=256"])).toBe("em-processo");
    expect(estrategiaPadrao(["--import", "./tsx-config.mjs"])).toBe("em-processo");
  });

  it("as flags do CMD do Dockerfile.worker escolhem o filho", async () => {
    // A cerca que faltou em 21/10/2026: o #2823 trocou `pnpm exec tsx` por
    // `node --import tsx`, o caso acima só conhecia a forma antiga, e o worker
    // de produção voltou a carregar o pdfjs no próprio heap. Este caso lê o CMD
    // da imagem em vez de repetir à mão o que ele diz hoje.
    const dockerfile = readFileSync(join(raiz, "Dockerfile.worker"), "utf8");
    const linha = dockerfile.split("\n").find((l) => /^CMD\s*\[/.test(l));
    expect(linha, "Dockerfile.worker sem CMD em forma exec").toBeTruthy();
    const cmd = JSON.parse(linha!.replace(/^CMD\s*/, "")) as string[];
    expect(cmd[0], `o CMD não começa por node: ${JSON.stringify(cmd)}`).toBe("node");
    // Entre `node` e o script de entrada (o último item) está o `execArgv`.
    const execArgv = cmd.slice(1, -1);
    const { estrategiaPadrao } = await import("@/lib/ai/rag/extractors/pdf");
    expect(estrategiaPadrao(execArgv), `execArgv do CMD: ${JSON.stringify(execArgv)}`).toBe(
      "processo-a-parte",
    );
  });

  // As duas formas de pôr o `tsx` no processo: a CLI (o CMD até o #2823) e o
  // hook `--import tsx` (o CMD depois dele). Só a primeira era exercitada, e foi
  // a segunda que derrubou a produção em 21/10/2026.
  it.each([
    ["pela CLI do tsx", ["node_modules/tsx/dist/cli.mjs", "--eval"]],
    ["por node --import tsx", ["--import", "tsx", "--eval"]],
  ])(
    "sob o tsx DE VERDADE (%s), o pai extrai sem carregar o pdfjs no próprio heap",
    (_forma, lancador) => {
      // Este é o único caso que exercita o caminho que o worker de produção
      // percorre: o `tsx` real, não um `execArgv` de mentira. Sob ele, a extração
      // em processo custava 117 MB de heap (medido na imagem 1.27.1); com o filho,
      // o que fica no pai é o custo de um `spawn`. O limite de 60 MB tem margem
      // dos dois lados.
      const script = `
        const fs = require("node:fs");
        import("@/lib/ai/rag/extractors/pdf").then(async (m) => {
          const texto = await m.extractPdfText(fs.readFileSync("tests/fixtures/sample-multipagina.pdf"));
          process.stdout.write(JSON.stringify({
            estrategia: m.estrategiaPadrao(),
            texto,
            heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
          }));
        }).catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
      `;
      const saida = execFileSync(process.execPath, [...lancador, script], {
        cwd: raiz,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      const r = JSON.parse(saida) as { estrategia: string; texto: string; heapMb: number };
      expect(r.estrategia).toBe("processo-a-parte");
      expect(r.texto).toBe(
        "Pagina um linha um\nPagina um linha dois\n\nPagina dois linha um\nPagina dois linha dois",
      );
      expect(r.heapMb, `heap do pai sob tsx: ${r.heapMb} MB`).toBeLessThan(60);
    },
  );
});
