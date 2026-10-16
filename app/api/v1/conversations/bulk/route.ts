import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/bulk — a camada de lote da Inbox (#2484, fatia F1).
 *
 * UMA rota para todas as ações em lote (`close`, `archive`, `mark-read`,
 * `pause-ai`, `reactivate-bot`, `transfer`), discriminada por `action`.
 *
 * ── O desenho, e por que ele NÃO é o do `leads/bulk` ─────────────────────
 *
 * A rota de lote dos leads resolve a visibilidade do LOTE com uma consulta só
 * (`select … .in("id", ids).eq("organization_id", …)`) e recusa a chamada
 * INTEIRA quando algum id não aparece (`if (!first) return 404`). Faz sentido
 * lá: `fn_mover_leads_em_lote` é uma transação só — ou move todos, ou não move
 * nenhum —, então um card invisível derrubaria a operação de qualquer jeito.
 *
 * Aqui é o oposto, e de propósito: um lote de conversas é N conversas
 * independentes, e o relatório da issue pede o resultado DE CADA ITEM (feito /
 * recusado e por quê). Uma consulta de visibilidade no nível do lote seria
 * justamente o defeito: ela esconderia QUAL id foi recusado, e um id de outra
 * organização — ou um id que não existe — derrubaria junto os itens bons.
 *
 * Então cada id é encaminhado, UM A UM, ao MESMO handler da conversa
 * individual (`app/api/v1/conversations/[id]/…`). Quem decide tudo continua
 * sendo ele:
 *
 *  - PERMISSÃO: cada rota roda `requireSupportWrite` + `requireRole("agent")`
 *    — a mesma função, com o mesmo piso, não uma cópia da régua;
 *  - ORGANIZAÇÃO: cada rota lê a org da SESSÃO (cookie validado) e filtra por
 *    ela. Esta rota não consulta organização nenhuma — não existe campo de org
 *    no corpo, e a sessão é a única fonte;
 *  - AUDITORIA: cada rota escreve a sua própria entrada (`conversation.closed`,
 *    `conversation.transferred`, `conversation.ai_paused`, …), uma por
 *    conversa — exceto `mark-read`, que já não audita na rota individual.
 *    Não há auditoria do lote: uma entrada agregada apagaria qual conversa
 *    sofreu qual ação.
 *
 * ── O que esta rota acrescenta ────────────────────────────────────────────
 *
 * 1. O portão da CHAMADA: `requireRole("agent")` uma vez, antes de qualquer
 *    item — um `viewer` recebe 403 pela chamada, não uma lista de 100 itens
 *    recusados. (Os handlers por item revalidam: a fonte da permissão continua
 *    sendo eles.)
 * 2. O TETO por chamada (`TETO_DO_LOTE`), recusado com 422 `bulk_too_large` e
 *    o número na mensagem.
 * 3. O RELATÓRIO por item, com o `request_id` de cada subchamada para quem
 *    precisar correlacionar com a auditoria.
 *
 * ── A resposta é 200 mesmo com itens recusados ────────────────────────────
 *
 * A chamada foi bem-sucedida: ela fez o que pôz e recusou o que não pôde, com
 * o motivo de cada recusa. Código de erro HTTP reserva-se para a CHAMADA
 * (401/403/422/500) — um lote pela metade não é erro de quem chamou, é o
 * resultado. Só assim a tela pode dizer "8 feitos, 2 recusados" em vez de
 * mostrar um erro vermelho por uma conversa que já era de outra organização.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { bulkConversationActionSchema, validateRequest } from "@/lib/schemas";
import type { BulkConversationActionInput } from "@/lib/schemas";

import { POST as fecharUmaConversa } from "../[id]/close/route";
import { POST as marcarComoLida } from "../[id]/mark-read/route";
import { POST as pausarAutomatico } from "../[id]/pause-ai/route";
import { POST as devolverAoAutomatico } from "../[id]/reactivate-bot/route";
import { POST as transferirUmaConversa } from "../[id]/transfer/route";
import { PATCH as atualizarUmaConversa } from "../[id]/route";

export const dynamic = "force-dynamic";

/**
 * Quantas conversas uma chamada aceita. A issue #2484 pede "teto por chamada
 * (ex.: 100)"; 100 é o mesmo tamanho de página da lista, então um "selecionar
 * todas" feito com o que está na tela nunca estoura sozinho.
 */
export const TETO_DO_LOTE = 100;

/** Uma linha do relatório: o que aconteceu com UM id. */
interface ResultadoDoItem {
  id: string;
  feito: boolean;
  /** Código da recusa (`not_found`, `state_conflict`, …) — só quando recusado. */
  codigo?: string;
  /** O porquê, na língua de quem chamou. */
  motivo?: string;
  /** `X-Request-Id` da subchamada: correlação com a auditoria do item. */
  request_id?: string;
}

/**
 * Traduz a resposta do handler por item em uma linha do relatório.
 *
 * Lê o corpo de erro dos wrappers canônicos (`{ error: { code, message } }`) —
 * a mensagem JÁ vem traduzida pelo handler, na língua do usuário, e não é
 * reescrita aqui.
 */
async function classificar(res: Response, id: string): Promise<ResultadoDoItem> {
  const requestId = res.headers.get("X-Request-Id") ?? undefined;
  if (res.ok) return { id, feito: true, request_id: requestId };
  let codigo = "internal_error";
  let motivo = "Não foi possível concluir a ação nesta conversa.";
  try {
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    if (corpo.error?.code) codigo = corpo.error.code;
    if (corpo.error?.message) motivo = corpo.error.message;
  } catch {
    // Resposta sem corpo JSON: o código e a mensagem padrão já bastam.
  }
  return { id, feito: false, codigo, motivo, request_id: requestId };
}

/**
 * Monta o request sintético para a subchamada.
 *
 * O `ctx.params` é preenchido com o id do item — é assim que a rota por
 * conversa sabe de quem é a ação, e é a ÚNida via por que o id entra nela.
 * O corpo carrega só o que a ação pede (o destino, na transferência); jamais
 * organização, que vem da sessão.
 */
function requestDoItem(
  id: string,
  caminho: string,
  metodo: "POST" | "PATCH",
  corpo: Record<string, unknown>,
): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${id}${caminho}`, {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctxDoItem = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * Roda a ação escolhida no handler da conversa individual.
 *
 * A transferência de tipo é estreita: `fecharUmaConversa` etc. são os `POST`
 * exportados pelas rotas irmãs, com a assinatura `(req, ctx)` que elas mesmas
 * declaram. Nenhuma regra é reimplementada aqui — se a rota individual muda,
 * o lote muda com ela no mesmo commit.
 */
async function executarNoItem(
  acao: BulkConversationActionInput["action"],
  id: string,
  toUserId: string | undefined,
  reason: string | undefined,
): Promise<Response> {
  switch (acao) {
    case "close":
      return fecharUmaConversa(requestDoItem(id, "/close", "POST", {}), ctxDoItem(id));
    case "archive":
      // O arquivamento da #923 vai pelo MESMO PATCH versionado de status — não
      // existe rota dedicada, e criar uma segunda só para o lote seria o
      // segundo caminho para o mesmo UPDATE.
      return atualizarUmaConversa(
        requestDoItem(id, "", "PATCH", { status: "archived" }),
        ctxDoItem(id),
      );
    case "mark-read":
      return marcarComoLida(requestDoItem(id, "/mark-read", "POST", {}), ctxDoItem(id));
    case "pause-ai":
      return pausarAutomatico(requestDoItem(id, "/pause-ai", "POST", {}), ctxDoItem(id));
    case "reactivate-bot":
      return devolverAoAutomatico(
        requestDoItem(id, "/reactivate-bot", "POST", {}),
        ctxDoItem(id),
      );
    case "transfer":
      return transferirUmaConversa(
        requestDoItem(id, "/transfer", "POST", {
          to_user_id: toUserId,
          ...(reason ? { reason } : {}),
        }),
        ctxDoItem(id),
      );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // O portão da CHAMADA. Os handlers por item revalidam role e org — este
  // cheque existe para o `viewer` não receber N itens recusados no lugar de um
  // 403, e para nenhuma subchamada ser feita antes de saber quem está chamando.
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let input: BulkConversationActionInput;
  try {
    input = await validateRequest(bulkConversationActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.ids.length > TETO_DO_LOTE) {
    return fail(
      "bulk_too_large",
      `${t("Máximo")} ${TETO_DO_LOTE} ${t("conversas por chamada.")}`,
      422,
      { requestId },
    );
  }

  // Um item por vez, na ordem pedida: a auditoria de cada conversa carrega o
  // request_id da própria subchamada, e a ordem do relatório é a ordem dos ids.
  // Nada de lote transacional: cada item acontece ou recusa sozinho.
  const resultados: ResultadoDoItem[] = [];
  for (const id of input.ids) {
    try {
      const res = await executarNoItem(
        input.action,
        id,
        "to_user_id" in input ? input.to_user_id : undefined,
        "reason" in input ? input.reason : undefined,
      );
      resultados.push(await classificar(res, id));
    } catch (err) {
      // Defesa em último nível: um handler que ESTOURO em vez de responder
      // recusa o item, nunca a chamada. O lote continua para os outros ids.
      resultados.push({
        id,
        feito: false,
        codigo: "internal_error",
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const feitos = resultados.filter((r) => r.feito).length;

  return ok(
    {
      acao: input.action,
      teto: TETO_DO_LOTE,
      total: resultados.length,
      feitos,
      recusados: resultados.length - feitos,
      resultados,
    },
    { requestId },
  );
}
