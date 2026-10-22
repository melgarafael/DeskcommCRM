/**
 * PDF text extractor for the RAG ingestion pipeline.
 *
 * UMA engine: pdfjs-dist (build `legacy`, que é a que roda em Node).
 * Uma tentativa só. Se ela falhar, lança PdfExtractError — não há segunda.
 *
 * Este arquivo já teve duas tentativas (pdf-parse como primária, pdfjs como
 * fallback) e elas NÃO eram duas engines. O pdf-parse@1 vendoriza quatro cópias
 * completas do pdf.js da Mozilla dentro de si — 29 dos 29 MB do pacote estão em
 * `lib/` — e fixa a `v1.10.100`, de 2018. Ou seja: era o MESMO pdf.js duas vezes,
 * com 7 majors de distância, e a cópia velha rodava PRIMEIRO.
 *
 * Medido na issue #238: a v1.10.100 falha com "bad XRef entry" na própria fixture
 * deste repo (`tests/fixtures/sample-text.pdf`) e com "Illegal character: 41" num
 * PDF gerado pelo @react-pdf/renderer. A "primária" já estava morta há tempos e
 * quem extraía era o fallback — o teste verde media o caminho de baixo achando que
 * media o de cima. Redundância que não é redundante é código morto, e este arquivo
 * já pagou por isso uma vez (issue #102, no comentário lá embaixo).
 *
 * ─── DUAS ESTRATÉGIAS, UMA ENGINE ───────────────────────────────────────────
 *
 * A engine é a mesma nas duas; o que muda é ONDE ela roda:
 *
 * - `em-processo`: `import()` do pdfjs aqui mesmo. É o caminho do app Next (que
 *   empacota o pdfjs no build) e o dos testes.
 * - `processo-a-parte`: um `node` puro, filho deste processo, importa o pdfjs e
 *   devolve o texto pela saída padrão. É o caminho do worker, que roda sob `tsx`.
 *
 * Por que o worker não pode importar o pdfjs em processo — MEDIDO, dentro da
 * imagem `deskcomm-worker:1.27.1`, com a fixture `sample-multipagina.pdf` (1 KB):
 *
 *   pnpm exec tsx  → heapUsed 117 MB, RSS 320 MB, 1.878 ms
 *   node           → heapUsed  19 MB, RSS  94 MB,   192 ms
 *
 * O `tsx` reescreve os `import()` dinâmicos de TODO módulo ESM que carrega, e
 * para isso transforma `pdf.mjs` (1 MB) e `pdf.worker.mjs` (2,4 MB) inteiros com
 * o esbuild, guardando fonte transformada e source map no heap. Com um PDF real
 * de 18 KB o custo passou de 227 MB, e o teto do heap do worker é ~256 MB
 * (`mem_limit: 512m` no compose): `FATAL ERROR: Reached heap limit`, o contêiner
 * reinicia, e como um processo derrubado não incrementava `attempts`, o mesmo
 * evento voltava e derrubava de novo — 313 reinícios numa VPS em 2026-09-15, com
 * o agente sem responder e nenhum PDF derivado desde 04/09. `createRequire` não
 * escapa: o hook CJS do `tsx` também transforma (68 MB, medido).
 *
 * O processo filho resolve as duas coisas de uma vez: sai do `tsx`, e ISOLA o
 * heap — um PDF patológico mata o filho, o handler recebe um erro comum, e o
 * dreno conta a tentativa. O worker não morre por causa de um arquivo.
 *
 * `estrategiaPadrao()` escolhe `processo-a-parte` só quando este processo está
 * sob o `tsx` (os hooks dele aparecem em `process.execArgv`). No app Next o
 * pdfjs vive dentro do bundle, não existe `pdf.mjs` em disco no standalone, e
 * o custo do `tsx` não existe — então lá nada muda.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type * as PdfjsDist from "pdfjs-dist";

/**
 * Por que a extração falhou, para quem precisa decidir sem ler a frase.
 *
 * - `sem_texto`: o PDF abriu inteiro e não tem letra selecionável (escaneado).
 *   É conteúdo, não defeito — quem chama não deve alarmar ninguém.
 * - `falha`: a engine não conseguiu ler (pacote ausente no build, binário
 *   nativo faltando, arquivo corrompido).
 *
 * `ingest/documento.ts` comparava `err.message` com a frase inglesa lançada
 * aqui; traduzir a frase faria todo PDF escaneado ser logado como falha de
 * infraestrutura. A frase é para gente e pode mudar; o motivo não.
 */
export type MotivoDaFalhaDePdf = "sem_texto" | "falha";

export class PdfExtractError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly motivo: MotivoDaFalhaDePdf = "falha",
  ) {
    super(message);
    this.name = "PdfExtractError";
  }
}

export type EstrategiaDeExtracao = "em-processo" | "processo-a-parte";

export interface OpcoesDeExtracao {
  estrategia?: EstrategiaDeExtracao;
  /**
   * Teto do heap do processo filho, em MB. Existe para que um PDF grande demais
   * mate o FILHO com `heap limit` — e não o contêiner inteiro. Sem teto, o filho
   * cresce até o `mem_limit` do cgroup e o OOM killer do kernel escolhe a vítima
   * por tamanho, que é o worker (baseline ~170 MB de RSS), não o filho.
   *
   * 160 MB: a fixture custa 19 MB em `node` puro; sobra 8× para um PDF real, e
   * worker (~170 MB) + filho (heap + ~70 MB de runtime) cabem nos 512 MB.
   */
  heapMb?: number;
  /** Depois disto o filho é morto e a extração falha com `PdfExtractError`. */
  timeoutMs?: number;
}

const PDFJS_LEGACY = "pdfjs-dist/legacy/build/pdf.mjs";
const HEAP_DO_FILHO_MB = 160;
const TEMPO_MAXIMO_MS = 60_000;

/**
 * `processo-a-parte` só sob o `tsx` — é o único lugar onde o custo existe.
 *
 * O `tsx` aparece no `execArgv` de duas formas, e as duas já foram produção:
 *
 * - pela CLI (`pnpm exec tsx`, o CMD antigo da imagem): caminhos absolutos,
 *   `.../node_modules/tsx/dist/loader.mjs`;
 * - pelo hook (`node --import tsx`, o CMD desde o #2823): o especificador CRU,
 *   `tsx` — ou `tsx/esm`, ou `--import=tsx`. Sem barra antes.
 *
 * Até 21/10/2026 só a primeira forma era reconhecida. O #2823 trocou o CMD, a
 * estratégia caiu para `em-processo` em silêncio, e o primeiro PDF recebido
 * derrubou o worker com `heap limit` — o incidente de 15/09 de volta.
 */
export function estrategiaPadrao(
  execArgv: readonly string[] = process.execArgv,
): EstrategiaDeExtracao {
  return execArgv.some((arg) => /(^|[\\/=])tsx([\\/]|$)/.test(arg))
    ? "processo-a-parte"
    : "em-processo";
}

/**
 * Extrai texto puro de um buffer de PDF usando pdfjs-dist.
 * Lança `PdfExtractError` se o arquivo for ilegível ou não tiver texto algum.
 */
export async function extractPdfText(
  buffer: Buffer,
  opcoes: OpcoesDeExtracao = {},
): Promise<string> {
  const estrategia = opcoes.estrategia ?? estrategiaPadrao();
  if (estrategia === "processo-a-parte") return extrairEmProcessoAParte(buffer, opcoes);
  return extrairEmProcesso(buffer);
}

async function extrairEmProcesso(buffer: Buffer): Promise<string> {
  try {
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof PdfjsDist;

    // NÃO mexa em GlobalWorkerOptions.workerSrc aqui (issue #102).
    //
    // Havia um `workerSrc = ""` nesta linha, com a intenção de "desligar o worker
    // em Node". O efeito era o oposto: string vazia é falsy, e o getter
    // `PDFWorker.workerSrc` lança `No "GlobalWorkerOptions.workerSrc" specified.`
    // ANTES de ler um byte do arquivo — ou seja, a extração inteira era inalcançável,
    // e o erro chegava ao usuário como a mensagem genérica lá de baixo.
    //
    // Em Node o pdf.js já se auto-configura; as três linhas sobrescreviam justamente
    // o que a lib tinha preparado. Medido nas versões 4.10.38 e 6.2.108: com
    // `workerSrc = ""` falha nas duas; sem tocar, extrai nas duas.
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdfDocument = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const content = await page.getTextContent();

      // A quebra de linha vem do `hasEOL` do próprio pdf.js, não de comparar o Y do
      // `transform`. Medido na issue #238 com um PDF que tem "10,00" + um "2"
      // sobrescrito na MESMA linha visual: agrupar por `transform[5]` (o que o
      // pdf-parse fazia) devolve `"Assinatura R$ 10,00\n2 \npor mes"` — três linhas
      // onde há uma —, enquanto `hasEOL` devolve `"Assinatura R$ 10,002 por mes"`.
      // O sobrescrito muda o Y sem terminar a linha; só a engine sabe disso.
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      if (pageText.length > 0) pageTexts.push(pageText);
    }

    const combined = pageTexts.join("\n\n").trim();
    if (combined.length === 0) {
      throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)", undefined, "sem_texto");
    }
    return combined;
  } catch (err) {
    throw traduzirErro(err);
  }
}

function traduzirErro(err: unknown): PdfExtractError {
  if (err instanceof PdfExtractError) return err;

  // O pdfjs 6 faz `new DOMMatrix()` no topo do módulo e depende do
  // `@napi-rs/canvas` (optionalDependency) para o polyfill. Sem esse binário —
  // plataforma sem binding publicado, registry corporativo sem os artefatos, ou
  // instalação com optional deps podadas — ele estoura no IMPORT, antes de ler o
  // arquivo. A versão 4 só avisava e extraía o texto assim mesmo.
  //
  // Sem esta mensagem, quem instalou vê "DOMMatrix is not defined" e não tem como
  // ligar isso a uma dependência que ele nem sabe que existe. O diagnóstico custa
  // 4 linhas; a caçada custa uma tarde.
  //
  // ⚠️ A INSTRUÇÃO É PARA QUEM VAI LÊ-LA, e quem lê NÃO é quem desenvolve.
  // `extrairTextoDoArquivo` não repassa esta frase para a tela — de propósito:
  // a pessoa recebe sempre "não consegui extrair texto deste PDF…", e é o
  // `console.error("[extracao-pdf] falha de infraestrutura…")` que carrega ESTA
  // mensagem. O leitor, portanto, é quem abre o log do contêiner: o dono da VPS.
  // A versão anterior mandava "reinstale as dependências (`pnpm install`, não
  // `--no-optional`)", e num self-host não há `node_modules` para reinstalar —
  // a imagem Docker é pré-buildada no CI e o kit não expõe passo nenhum de
  // instalação de pacote (doutrina de packaging: nada constrói na máquina do
  // cliente). Instrução impossível de seguir lê como "está quebrado e não há o
  // que fazer".
  //
  // O que ele PODE fazer está escrito, e sem prometer: atualizar a instalação
  // resolve QUANDO a imagem publicada já traz o binário — não resolve se a poda
  // aconteceu no build —, e o caminho que sempre existe é avisar quem instalou.
  // A causa não é suavizada: o nome do pacote fica, porque é ele que quem
  // instalou vai procurar.
  const mensagem = err instanceof Error ? err.message : String(err);
  if (/DOMMatrix|@napi-rs\/canvas/.test(mensagem)) {
    return new PdfExtractError(
      "Extração de PDF indisponível nesta instalação: falta o binário nativo " +
        "@napi-rs/canvas, que o leitor de PDF usa. Não é o arquivo enviado — não há nada " +
        "a corrigir nele. Atualize a instalação (`bash update.sh`); se o erro " +
        "continuar, avise quem instalou o sistema, porque o binário ficou de fora da " +
        "imagem. Enquanto isso, o mesmo conteúdo em texto (.txt), Markdown (.md) ou " +
        "CSV (.csv) é lido normalmente.",
      err,
    );
  }

  return new PdfExtractError("pdfjs-dist failed to extract text from the PDF", err);
}

/**
 * O que o filho executa. É a MESMA extração de `extrairEmProcesso`, em JS puro,
 * porque o filho é `node` sem `tsx` e não pode importar este arquivo. A
 * duplicação é vigiada por `tests/unit/pdf-extractor.test.ts`, que exige texto
 * idêntico das duas estratégias em todas as fixtures.
 *
 * Protocolo: PDF inteiro pela entrada padrão; UMA linha JSON pela saída padrão,
 * `{ ok: true, texto }` ou `{ ok: false, erro }`. Os avisos do pdfjs vão para a
 * saída de erro e ficam fora do protocolo.
 */
const SCRIPT_DO_FILHO = `
import { readFileSync } from "node:fs";
const responder = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
try {
  const pdfjs = await import(process.argv[1]);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(0)) }).promise;
  const paginas = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const conteudo = await (await doc.getPage(n)).getTextContent();
    const texto = conteudo.items
      .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\\n" : "") : ""))
      .join("")
      .trim();
    if (texto.length > 0) paginas.push(texto);
  }
  responder({ ok: true, texto: paginas.join("\\n\\n").trim() });
} catch (e) {
  responder({ ok: false, erro: String((e && e.message) || e) });
}
`;

function urlDoPdfjs(): string {
  // `require.resolve` a partir DESTE arquivo: sob o tsx o worker é CJS e
  // `__filename` existe; o filho recebe a URL pronta e não resolve nada.
  return pathToFileURL(createRequire(__filename).resolve(PDFJS_LEGACY)).href;
}

interface RespostaDoFilho {
  ok: boolean;
  texto?: string;
  erro?: string;
}

interface SaidaDoFilho {
  codigo: number | null;
  sinal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function extrairEmProcessoAParte(
  buffer: Buffer,
  opcoes: OpcoesDeExtracao,
): Promise<string> {
  const heapMb = opcoes.heapMb ?? HEAP_DO_FILHO_MB;
  const timeoutMs = opcoes.timeoutMs ?? TEMPO_MAXIMO_MS;

  let url: string;
  try {
    url = urlDoPdfjs();
  } catch (err) {
    throw traduzirErro(err);
  }

  // NODE_OPTIONS sai do ambiente do filho: é por ali que um `--import tsx`
  // voltaria para dentro sem ninguém ver.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const saida = await new Promise<SaidaDoFilho>((resolve, reject) => {
    const filho = spawn(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, "--input-type=module", "--eval", SCRIPT_DO_FILHO, url],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let expirou = false;
    const relogio = setTimeout(() => {
      expirou = true;
      filho.kill("SIGKILL");
    }, timeoutMs);
    filho.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    filho.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    filho.on("error", (err) => {
      clearTimeout(relogio);
      reject(new PdfExtractError(`não consegui abrir o processo de extração: ${err.message}`, err));
    });
    filho.on("close", (codigo, sinal) => {
      clearTimeout(relogio);
      if (expirou) {
        reject(new PdfExtractError(`a extração do PDF excedeu ${timeoutMs} ms e foi interrompida`));
        return;
      }
      resolve({ codigo, sinal, stdout, stderr });
    });
    // EPIPE se o filho morrer antes de ler tudo: o `close` acima já explica.
    filho.stdin.on("error", () => {});
    filho.stdin.end(buffer);
  });

  const linha = saida.stdout.trim().split("\n").pop() ?? "";
  let resposta: RespostaDoFilho | null = null;
  try {
    resposta = linha ? (JSON.parse(linha) as RespostaDoFilho) : null;
  } catch {
    resposta = null;
  }

  if (!resposta) {
    // Morreu sem responder: heap estourado, sinal, ou um `import` que falhou
    // antes do `try`. O que o filho escreveu no stderr é o diagnóstico.
    const causa = saida.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    const como = saida.sinal ? `sinal ${saida.sinal}` : `código ${saida.codigo}`;
    const erro = new Error(
      `o processo de extração terminou sem responder (${como}, teto de heap ${heapMb} MB)` +
        (causa ? `: ${causa}` : ""),
    );
    // A frase vai INTEIRA para o `last_error` do evento: "sinal SIGSEGV, teto de
    // heap 160 MB" é o que distingue PDF grande demais de PDF corrompido.
    if (/DOMMatrix|@napi-rs\/canvas/.test(causa)) throw traduzirErro(erro);
    throw new PdfExtractError(erro.message, erro);
  }
  if (!resposta.ok) throw traduzirErro(new Error(resposta.erro ?? "erro desconhecido"));

  const texto = resposta.texto ?? "";
  if (texto.length === 0) {
    throw new PdfExtractError("pdfjs-dist extracted no text (possibly image-only PDF)");
  }
  return texto;
}
