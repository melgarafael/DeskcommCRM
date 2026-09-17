/**
 * O TEXTO DO ACERVO — de bytes a markdown, sem mojibake.
 *
 * O defeito (issue #531): aqui era `buffer.toString("utf8")` para tudo. Um
 * `.txt` ou `.md` que o Bloco de Notas salva em cp1252 — o padrão de quem monta
 * base de conhecimento no Windows — entrava na base que o agente lê com cada
 * acento virando U+FFFD ("Ação" entrava como "A��o"), e SEM erro nenhum: a pessoa via o
 * material pronto, o índice era construído, e o agente passava a citar o texto
 * corrompido para o cliente. Falha aberta, no caminho de
 * `app/api/v1/ai/knowledge/sources/upload/route.ts`.
 *
 * A decisão de codificação não é nova nem local: é `decodificarBytesDeTexto`
 * (`lib/contacts/csv.ts`), a regra que o #483 deixou para as planilhas. Reusar
 * é o ponto — duas regras de charset neste repo seriam duas respostas para a
 * mesma pergunta, e a que ninguém lembrar de atualizar é a que envelhece.
 *
 * Os bytes nunca são adivinhados: o que não parece texto (`.xlsx` renomeado
 * para `.md`, UTF-16 com acento) LANÇA `ArquivoBinarioError` em vez de virar
 * texto de aparência plausível. Quem transforma isso na frase da tela é
 * `lib/ai/rag/ingest/documento.ts`, que é quem conhece a extensão pedida.
 */

import { decodificarBytesDeTexto } from "@/lib/contacts/csv";

/** O arquivo não é texto: os bytes não formam Markdown nem texto puro. */
export class ArquivoBinarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArquivoBinarioError";
  }
}

/**
 * Extrai o texto de um buffer de markdown e descarta o frontmatter YAML
 * (`---`…`---`), que é metadado do arquivo — quem lê o trecho é o agente, e
 * `tags:` não é resposta para cliente.
 */
export function extractMarkdownText(buffer: Buffer): string {
  const decodificado = decodificarBytesDeTexto(buffer);
  if ("binario" in decodificado) {
    throw new ArquivoBinarioError("os bytes não formam Markdown nem texto puro");
  }
  const raw = decodificado.texto;

  // Frontmatter é bloco de abertura; `---` no meio do texto é linha horizontal.
  if (raw.trimStart().startsWith("---")) {
    // Acha o `---` de fechamento, que precisa estar sozinho numa linha depois
    // da abertura.
    const afterOpen = raw.indexOf("---") + 3; // pula o `---` de abertura
    const closeIdx = raw.indexOf("\n---", afterOpen);
    if (closeIdx !== -1) {
      // Tudo depois do fechamento, sem a quebra que veio colada nele.
      return raw
        .slice(closeIdx + 4)
        .replace(/^\n/, "")
        .trim();
    }
  }

  return raw.trim();
}
