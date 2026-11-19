/**
 * DE ARQUIVO A TEXTO — a metade que faltava do caminho de documento.
 *
 * O que existia (`ingest/policy.ts`) baixava o blob, extraía, chunkava, **logava
 * a contagem e devolvia `{ chunkCount }` sem persistir nada**. Nem chunk, nem
 * item, nem texto: o material subia, a fonte nascia com `status='ready'`, e não
 * havia caminho nenhum que transformasse aquele PDF em trecho buscável — o
 * indexador só sabia ler `ai_faq_items`.
 *
 * Este módulo faz só a extração. Quem chunka, embeda e grava é o indexador
 * (`workers/rag-indexer.ts`), no mesmo lugar em que faz isso para os outros
 * tipos de material — porque o custo de embedar pertence ao worker, não à
 * requisição HTTP de quem clicou em "enviar".
 *
 * O bucket continua se chamando `ai-policy`. O nome é histórico e ficou de
 * propósito: renomeá-lo invalidaria o `blob_path` de todo arquivo já enviado em
 * qualquer instalação, e trocar um nome feio por uma migração de dados em disco
 * de cliente é péssimo negócio.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ArquivoBinarioError,
  extractMarkdownText,
} from "@/lib/ai/rag/extractors/markdown";
import { extractPdfText, PdfExtractError } from "@/lib/ai/rag/extractors/pdf";
import { extractCsvText, CsvExtractError } from "@/lib/ai/rag/extractors/csv";

/** Bucket privado onde os arquivos de conhecimento vivem (nome histórico). */
export const BUCKET_DE_CONHECIMENTO = "ai-policy";

/**
 * Extensões que o produto sabe ler hoje.
 *
 * `xlsx`/`xls` NÃO entram de propósito — mesma decisão de `lib/contacts/csv.ts`:
 * todo Excel exporta CSV, e a mensagem de recusa em `extrairTextoDoArquivo`
 * ensina esse caminho em vez de carregar SheetJS/exceljs para o produto inteiro.
 */
export const EXTENSOES_ACEITAS = ["pdf", "md", "txt", "csv"] as const;
export type ExtensaoAceita = (typeof EXTENSOES_ACEITAS)[number];

/**
 * Falha de extração com motivo LEGÍVEL — ela vai direto para a linha da fonte e
 * para a Central de avisos, onde quem lê é o dono do negócio.
 *
 * `message` é também uma CHAVE DE UI: a rota de upload passa esse texto por
 * `traduzir()`. Por isso ele precisa ser estável, nunca conter extensão, texto
 * de exceção ou outro dado de runtime. `detalhe` preserva esse diagnóstico sem
 * misturá-lo ao texto que a pessoa vê.
 */
export class ErroDeExtracao extends Error {
  readonly code = "extracao_falhou";
  readonly detalhe?: string;

  constructor(message: string, detalhe?: string) {
    super(message);
    this.name = "ErroDeExtracao";
    this.detalhe = detalhe;
  }
}

export function resolverExtensao(
  nomeOuCaminho: string,
  mimeType?: string,
): ExtensaoAceita | null {
  const ext = nomeOuCaminho.split(".").pop()?.toLowerCase() ?? "";
  if ((EXTENSOES_ACEITAS as readonly string[]).includes(ext)) return ext as ExtensaoAceita;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "md";
  if (mimeType === "text/plain") return "txt";
  if (mimeType === "text/csv") return "csv";
  return null;
}

/**
 * Baixa o arquivo do Storage e devolve o texto puro.
 *
 * Lança `ErroDeExtracao` com frase de gente em toda falha — inclusive na do PDF
 * só-imagem, que é a mais comum e a que mais confunde: o arquivo abre
 * perfeitamente no leitor da pessoa e não tem uma letra selecionável.
 */
export async function extrairTextoDoArquivo(
  blobPath: string,
  extensaoDeclarada?: string,
  opcoes?: {
    /**
     * O bucket onde o objeto mora. O padrão continua `ai-policy` (o acervo de
     * conhecimento); os anexos de campo do negócio vivem em `internal-media` e
     * passam por aqui com o bucket explícito — a EXTRAÇÃO é uma só, o bucket é
     * do chamador (#4544).
     */
    bucket?: string;
  },
): Promise<{ texto: string; extensao: ExtensaoAceita }> {
  const extensao = resolverExtensao(extensaoDeclarada ?? blobPath, extensaoDeclarada);
  if (!extensao) {
    const extBruta = (extensaoDeclarada ?? blobPath.split(".").pop() ?? "?").toLowerCase();
    // Excel (.xlsx/.xls) tem instrução própria — a genérica ("envie PDF...") não
    // ensina o caminho de saída, que é exportar como CSV (mesma decisão de
    // `lib/contacts/csv.ts`, nunca carregar SheetJS/exceljs pra ler o binário).
    if (extBruta === "xlsx" || extBruta === "xls") {
      throw new ErroDeExtracao(
        "não leio Excel diretamente — no Excel use \"Salvar como\" → \"CSV UTF-8 " +
          '(delimitado por vírgulas)" e envie o CSV.',
      );
    }
    throw new ErroDeExtracao(
      // As DUAS intenções ficam: a chave é FIXA (só chave fixa tem tradução — é o
      // ponto do #1049 e da issue #1046) e o texto é o da main, que passou a
      // aceitar CSV. A extensão recusada sai da frase e vai para o `detalhe`,
      // que é quem leva a causa ao log e à linha da fonte.
      "Não sei ler esse tipo de arquivo. Envie PDF, Markdown (.md), CSV (.csv) ou texto (.txt).",
      extBruta || extensaoDeclarada || blobPath.split(".").pop() || "extensão desconhecida",
    );
  }

  const admin = createAdminClient();
  const { data: blob, error } = await admin.storage
    .from(opcoes?.bucket ?? BUCKET_DE_CONHECIMENTO)
    .download(blobPath);

  if (error || !blob) {
    throw new ErroDeExtracao(
      "O arquivo não está mais guardado. Envie de novo.",
      error?.message ?? "arquivo não encontrado no Storage",
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());

  let texto: string;
  if (extensao === "pdf") {
    try {
      texto = await extractPdfText(buffer);
    } catch (err) {
      if (err instanceof PdfExtractError) {
        // A mensagem que chega à pessoa é SEMPRE a de "só imagens escaneadas" —
        // é a única frase que faz sentido pra quem não sabe o que é pdfjs-dist.
        // Mas isso também apaga o diagnóstico de falha de INFRAESTRUTURA (pacote
        // ausente no build standalone, binário nativo faltando) que
        // `extractPdfText` já constrói com cuidado — e nem `documento.ts` nem
        // a rota de upload logavam `ErroDeExtracao` em lugar nenhum. Medido numa
        // instalação real em 2026-09-17: "Cannot find package 'pdfjs-dist'"
        // (pacote inteiro fora do tracing do `next build standalone`) virava
        // "só imagens escaneadas" pro operador, sem rastro nenhum em log.
        // A distinção é pelo `motivo`, nunca pela frase: a frase é traduzível.
        if (err.motivo !== "sem_texto") {
          console.error("[extracao-pdf] falha de infraestrutura, não de conteúdo:", err.message);
        }
        throw new ErroDeExtracao(
          "não consegui extrair texto deste PDF. Se ele for só imagens escaneadas, " +
            "não há letra nenhuma para ler — envie uma versão com texto selecionável.",
        );
      }
      throw new ErroDeExtracao(
        "Falha ao processar o envio do arquivo.",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else if (extensao === "csv") {
    try {
      texto = extractCsvText(buffer);
    } catch (err) {
      // Mesma regra, e ela não é estilo: esta mensagem chega à tela pela rota de
      // upload, que a passa por `t()`. Texto montado em tempo de execução nunca
      // casa no dicionário e sai em português para quem usa em espanhol.
      if (err instanceof CsvExtractError) {
        throw new ErroDeExtracao("Falha ao processar o envio do arquivo.", err.message);
      }
      throw new ErroDeExtracao(
        "Falha ao processar o envio do arquivo.",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    // `.txt` e `.md` seguem o mesmo caminho: a limpeza de frontmatter é inócua
    // num texto puro, e a decodificação é a MESMA para os dois — um segundo
    // extractor só duplicaria a regra de charset (ver `extractMarkdownText`).
    try {
      texto = extractMarkdownText(buffer);
    } catch (err) {
      if (err instanceof ArquivoBinarioError) {
        throw new ErroDeExtracao(
          "não consegui ler este arquivo como texto: os bytes não formam Markdown nem texto puro. " +
            "Salve o material em UTF-8 (ou ANSI) e envie de novo — se o arquivo não for de texto, envie PDF.",
        );
      }
      throw err;
    }
  }

  if (texto.trim().length === 0) {
    throw new ErroDeExtracao("o arquivo não tem texto nenhum para indexar");
  }

  return { texto, extensao };
}
