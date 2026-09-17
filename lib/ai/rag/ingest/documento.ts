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

/** Bucket privado onde os arquivos de conhecimento vivem (nome histórico). */
export const BUCKET_DE_CONHECIMENTO = "ai-policy";

/** Extensões que o produto sabe ler hoje. */
export const EXTENSOES_ACEITAS = ["pdf", "md", "txt"] as const;
export type ExtensaoAceita = (typeof EXTENSOES_ACEITAS)[number];

/**
 * Falha de extração com motivo LEGÍVEL — ela vai direto para a linha da fonte e
 * para a Central de avisos, onde quem lê é o dono do negócio.
 */
export class ErroDeExtracao extends Error {
  readonly code = "extracao_falhou";
  constructor(message: string) {
    super(message);
    this.name = "ErroDeExtracao";
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
): Promise<{ texto: string; extensao: ExtensaoAceita }> {
  const extensao = resolverExtensao(extensaoDeclarada ?? blobPath);
  if (!extensao) {
    throw new ErroDeExtracao(
      `não sei ler arquivos "${extensaoDeclarada ?? blobPath.split(".").pop() ?? "?"}" — ` +
        `envie PDF, Markdown ou texto`,
    );
  }

  const admin = createAdminClient();
  const { data: blob, error } = await admin.storage.from(BUCKET_DE_CONHECIMENTO).download(blobPath);

  if (error || !blob) {
    throw new ErroDeExtracao(
      `o arquivo não está mais guardado (${error?.message ?? "não encontrado"}) — envie de novo`,
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
        if (err.message !== "pdfjs-dist extracted no text (possibly image-only PDF)") {
          console.error("[extracao-pdf] falha de infraestrutura, não de conteúdo:", err.message);
        }
        throw new ErroDeExtracao(
          "não consegui extrair texto deste PDF. Se ele for só imagens escaneadas, " +
            "não há letra nenhuma para ler — envie uma versão com texto selecionável.",
        );
      }
      throw new ErroDeExtracao(
        `falhou ao ler o PDF: ${err instanceof Error ? err.message : String(err)}`,
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
