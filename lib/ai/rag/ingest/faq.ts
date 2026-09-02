/**
 * FAQ markdown ingestion helpers.
 *
 * Supports two section marker styles (case-insensitive):
 *   ## Pergunta: / ## Resposta:
 *   ## P: / ## R:
 *
 * Optional YAML frontmatter (---) applies locale/tags defaults to all items
 * that do not specify their own.
 *
 * Example markdown:
 *   ---
 *   locale: pt-PT
 *   tags: [envio, prazo]
 *   ---
 *   ## Pergunta: Qual o prazo de entrega?
 *   ## Resposta: Entregamos em até 7 dias úteis.
 */

export interface FaqItem {
  question: string;
  answer: string;
  tags: string[];
  locale: string;
}

const DEFAULT_LOCALE = "pt-PT";

/** Regex matching both `## Pergunta:` and `## P:` (case-insensitive). */
const QUESTION_RE = /^##\s+(?:pergunta|p)\s*:/i;
/** Regex matching both `## Resposta:` and `## R:` (case-insensitive). */
const ANSWER_RE = /^##\s+(?:resposta|r)\s*:/i;

interface Frontmatter {
  locale: string;
  tags: string[];
}

/**
 * Extracts YAML-style frontmatter block (---…---).
 * Supports only `locale: <string>` and `tags: [a, b, c]` keys.
 * Returns defaults if frontmatter is absent or unparseable.
 */
function parseFrontmatter(md: string): { frontmatter: Frontmatter; body: string } {
  const defaultFm: Frontmatter = { locale: DEFAULT_LOCALE, tags: [] };

  if (!md.trimStart().startsWith("---")) {
    return { frontmatter: defaultFm, body: md };
  }

  const closeIdx = md.indexOf("\n---", 3);
  if (closeIdx === -1) {
    return { frontmatter: defaultFm, body: md };
  }

  const fmBlock = md.slice(md.indexOf("\n") + 1, closeIdx).trim();
  const body = md.slice(closeIdx + 4).replace(/^\n/, "");

  const fm: Frontmatter = { ...defaultFm };

  for (const line of fmBlock.split("\n")) {
    const [key, ...rest] = line.split(":");
    const trimmedKey = (key ?? "").trim();
    const rawVal = rest.join(":").trim();

    if (trimmedKey === "locale" && rawVal) {
      fm.locale = rawVal;
    } else if (trimmedKey === "tags" && rawVal) {
      // Support inline array: [foo, bar] or [foo,bar]
      const inner = rawVal.replace(/^\[|\]$/g, "").trim();
      if (inner) {
        fm.tags = inner
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }

  return { frontmatter: fm, body };
}

/**
 * Parses FAQ markdown into structured items.
 * Returns an empty array if no valid question/answer pairs are found.
 */
export function parseFaqMarkdown(md: string): FaqItem[] {
  const { frontmatter, body } = parseFrontmatter(md);

  const lines = body.split("\n");
  const items: FaqItem[] = [];

  let currentQuestion: string | null = null;
  let currentAnswerLines: string[] = [];
  let inAnswer = false;

  const flushItem = () => {
    if (currentQuestion === null) return;
    const answer = currentAnswerLines.join("\n").trim();
    if (currentQuestion && answer) {
      items.push({
        question: currentQuestion,
        answer,
        tags: frontmatter.tags,
        locale: frontmatter.locale,
      });
    }
    currentQuestion = null;
    currentAnswerLines = [];
    inAnswer = false;
  };

  for (const line of lines) {
    if (QUESTION_RE.test(line)) {
      flushItem();
      // Extract the question text after the marker (e.g. "## Pergunta: text here")
      const colonIdx = line.indexOf(":");
      currentQuestion = line.slice(colonIdx + 1).trim();
      inAnswer = false;
    } else if (ANSWER_RE.test(line)) {
      const colonIdx = line.indexOf(":");
      const firstLine = line.slice(colonIdx + 1).trim();
      currentAnswerLines = firstLine ? [firstLine] : [];
      inAnswer = true;
    } else if (inAnswer) {
      // Accumulate answer lines until next section marker.
      currentAnswerLines.push(line);
    }
  }
  flushItem();

  return items;
}

/**
 * Formats a single FAQ item into a text chunk suitable for embedding.
 */
export function formatFaqChunk(item: FaqItem): string {
  const tagsStr = item.tags.length > 0 ? item.tags.join(", ") : "";
  return `Pergunta: ${item.question}\nResposta: ${item.answer}${tagsStr ? `\nTags: ${tagsStr}` : ""}`;
}
