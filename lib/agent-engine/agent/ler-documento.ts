/**
 * `ler_documento` — a ferramenta que abre UM material da base de conhecimento
 * pelo id, no turno do agente (#4133, item 2).
 *
 * ─── Por que ela existe ─────────────────────────────────────────────────────
 *
 * O modo `leitura_direta` troca a busca por embedding por duas peças: o índice
 * no contexto (`./indice-de-conhecimento`) e ESTA leitura. O modelo vê a lista
 * (`- [id] nome — resumo`) e, quando precisa do texto, pede o documento inteiro.
 * Nenhum provedor de embedding entra no caminho — só o LLM que já está no turno.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 *   - não chama modelo nenhum (custo não dobra por turno);
 *   - não devolve binário/base64 — só TEXTO extraído, o mesmo da tela;
 *   - não tem caminho próprio de extração: reusa `lerMaterial`
 *     (`lib/ai/knowledge/conteudo-do-material`), a MESMA ordem FAQ → blob →
 *     chunks da tela, com o adaptador de `pg.Pool` porque o turno não tem sessão.
 *
 * ─── Desfechos são ENSINO, nunca exceção ────────────────────────────────────
 *
 * Convenção do harness (`{ ok:false, error }`, ver `search-knowledge.ts`): uma
 * exceção mataria o turno e o cliente ficaria sem resposta. Id inexistente ou
 * de outra organização vira `documento_nao_encontrado` com o mesmo texto que
 * `get_lead_note` usa para id errado; material maior que o teto vira conteúdo
 * PARCIAL com `truncado:true` e o motivo escrito — nunca corte mudo.
 */
import type { Queryable } from "../queue/queue";
import type { extrairTextoDoArquivo } from "@/lib/ai/rag/ingest/documento";
import {
  lerMaterial,
  leitorDePool,
  type OrigemDoConteudo,
} from "@/lib/ai/knowledge/conteudo-do-material";

/**
 * Teto da leitura POR CHAMADA (~6,8k tokens pela régua de 3,5 chars/token).
 * Uma política de 40 páginas não cabe num turno de atendimento; o que passa
 * disso volta PARCIAL e com o motivo — o modelo sabe que leu só o começo.
 */
export const TETO_DE_CARACTERES_DO_DOCUMENTO = 24_000;

export interface DocumentoLido {
  ok: true;
  source_id: string;
  nome: string;
  origem: OrigemDoConteudo;
  /** Texto legível entregue ao modelo (FAQ renderizado como P:/R:). */
  conteudo: string;
  /** Quantos itens/trechos o material tem — não quantos couberam. */
  total: number;
  /** A leitura NÃO cobriu o material inteiro (há mais do que o entregue). */
  truncado: boolean;
  /** Por que está incompleto, ou o que impediu de ler o arquivo. `null` = inteiro. */
  motivo: string | null;
}

export type ErroDaLeituraDeDocumento = {
  ok: false;
  error: {
    code: "documento_nao_encontrado" | "documento_vazio" | "internal_error";
    message: string;
  };
};

export type ResultadoDaLeituraDeDocumento = DocumentoLido | ErroDaLeituraDeDocumento;

/** Pares de FAQ como texto: é o mesmo conteúdo da tela, em forma que o modelo lê. */
export function renderizarParesDeFaq(
  itens: readonly { question: string; answer: string }[],
): string {
  return itens.map((par) => `P: ${par.question}\nR: ${par.answer}`).join("\n\n");
}

/**
 * Lê UM material do acervo da organização do turno. Escopado por
 * `organizationId` — id de outra empresa é MISS, não vazamento.
 */
export async function lerDocumentoDoMaterial(
  db: Queryable,
  args: { organizationId: string; sourceId: string },
  deps?: {
    /** Injeção para teste: a extração do blob real fala com o Storage. */
    extrair?: typeof extrairTextoDoArquivo;
    /** Aviso de falha de infraestrutura (o chamador decide onde logar). */
    aviso?: (mensagem: string, dados?: Record<string, unknown>) => void;
  },
): Promise<ResultadoDaLeituraDeDocumento> {
  const sourceId = typeof args.sourceId === "string" ? args.sourceId.trim() : "";
  if (sourceId === "") {
    return {
      ok: false,
      error: {
        code: "documento_nao_encontrado",
        message:
          "não há material com esse id na base de conhecimento — confira o id no índice de documentos (entre colchetes).",
      },
    };
  }

  const leitura = await lerMaterial(
    leitorDePool(db),
    { orgId: args.organizationId, sourceId },
    deps?.extrair !== undefined ? { extrair: deps.extrair } : undefined,
  );

  if (!leitura.ok) {
    if (leitura.falha === "nao_encontrado") {
      return {
        ok: false,
        error: {
          code: "documento_nao_encontrado",
          message:
            "não há material com esse id na base de conhecimento desta empresa — confira o id no índice de documentos (entre colchetes).",
        },
      };
    }
    deps?.aviso?.("leitura de documento falhou no banco", { source_id: sourceId.slice(0, 64) });
    return {
      ok: false,
      error: {
        code: "internal_error",
        message:
          "não consegui ler este material agora — siga com o que você já sabe e não invente fatos.",
      },
    };
  }

  const material = leitura.material;
  const bruto =
    material.origem === "faq" && material.itens !== null
      ? renderizarParesDeFaq(material.itens)
      : (material.conteudo ?? "");

  if (bruto.trim() === "") {
    return {
      ok: false,
      error: {
        code: "documento_vazio",
        message:
          (material.motivo ?? "este material não tem texto legível.") +
          " Responda com o que você já sabe e não invente o conteúdo dele.",
      },
    };
  }

  let conteudo = bruto;
  let truncado = material.truncado;
  let motivo = material.motivo;
  if (bruto.length > TETO_DE_CARACTERES_DO_DOCUMENTO) {
    conteudo = bruto.slice(0, TETO_DE_CARACTERES_DO_DOCUMENTO);
    truncado = true;
    motivo =
      `o material tem ${bruto.length} caracteres e a leitura entregou os primeiros ` +
      `${TETO_DE_CARACTERES_DO_DOCUMENTO}; o restante não foi lido — não afirme o que só estaria lá.`;
  } else if (truncado && motivo === null) {
    motivo =
      `o material tem ${material.total} itens e a leitura entregou os primeiros ` +
      `${material.itens?.length ?? material.total}; o restante não foi lido.`;
  }

  return {
    ok: true,
    source_id: sourceId,
    nome: material.nome,
    origem: material.origem,
    conteudo,
    total: material.total,
    truncado,
    motivo,
  };
}
