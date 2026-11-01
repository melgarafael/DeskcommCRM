import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/cases/:id/close — ENCERRAR SEM AVISAR O CLIENTE (#3810).
 *
 * O caso `awaiting_human` que a vida já resolveu não tinha saída pela mão da
 * pessoa: a única porta era `POST .../reply`, e as TRÊS ações dela mandam
 * mensagem ao cliente (`resolved`/`need_lead_info` enfileiram `case_reply_turn`,
 * que é a IA voltando a falar; `escalate` chama o handoff humano). Quem só
 * queria tirar da fila um caso sem objeto — o cliente comprou em outro lugar, o
 * problema se resolveu sozinho — só conseguia fechando MENTINDO para o cliente,
 * ou deixando o caso imortal na fila de alguém.
 *
 * O desfecho certo já existia para o agente (`crm_close_human_case` com
 * `outcome: 'sem_necessidade'`: grava `cancelled`, deixa a nota na timeline e
 * não enfileira nada). Esta rota é a MESMA função — `encerrarChamadoPelaPessoa`
 * chama `encerrarChamadoComAutor`, mudando só o ator —, sem segunda
 * implementação nem SQL copiado aqui.
 *
 * Efeitos, todos deliberados:
 *   - `agent_cases.status = 'cancelled'` + `closed_at`;
 *   - um evento `cancelled` em `agent_case_events` com `actor_kind='human'`,
 *     `actor_user_id` da pessoa e a NOTA no corpo (a nota é obrigatória: sem ela
 *     o próximo atendente não sabe por que o caso morreu);
 *   - os avisos do sino do caso (`agent_inbox_items.ref_id`) resolvidos no
 *     MESMO commit — sem isso a Central segue cobrando uma decisão já tomada;
 *   - ZERO job enfileirado, ZERO handoff, ZERO mensagem ao cliente. Não é
 *     omissão: é o nome da ação. A rota não importa `enqueueJob`,
 *     `performHumanHandoff` nem `avisarLeadDoCrm` — quem for acrescentar um
 *     deles aqui está reabrindo o defeito que esta rota fecha.
 *
 * A única porta de entrada aceita é `awaiting_human` (409 nos outros estados,
 * espelhando `POST .../reply`). `awaiting_lead` também é um caso aberto e a
 * função de baixo o aceitaria; a recusa é da ROTA, e é de propósito — quando a
 * bola está com o cliente, fechar por aqui é decisão que merece passar por
 * "pedir informação"/"concluir", que avisam alguém.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { encerrarChamadoPelaPessoa } from "@/lib/agent-engine/agent/human-cases";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * `note` OBRIGATÓRIA e curta (2000, e não os 4000 da resposta): ela não vai
 * para o cliente, vai para a linha do tempo do caso — quem escreve para si
 * mesmo escreve menos.
 */
const bodySchema = z
  .object({
    note: z.string().trim().min(1).max(2000),
  })
  .strict();

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;
  const { id: caseId } = await params;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return fail("invalid_request", t("Body inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    // 400 e não 422 (que é o que `.../reply` devolve para body fora do schema):
    // aqui o campo é UM, e o único motivo de recusa é a nota faltando. O issue
    // #3810 pede 400, e a diferença visível para quem integra é nenhuma.
    return fail("invalid_request", t("Escreva a nota do encerramento."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { note } = parsed.data;

  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", t("Encerramento de caso indisponível (config)."), 503, {
      requestId,
    });
  }

  const { rows } = await pool.query<{ status: string }>(
    `select status from agent_cases where organization_id = $1 and id = $2`,
    [org.orgId, caseId],
  );
  const caseRow = rows[0];
  if (caseRow === undefined) {
    return fail("not_found", t("Caso não encontrado."), 404, { requestId });
  }
  if (caseRow.status !== "awaiting_human") {
    return fail(
      "invalid_state",
      t("O caso não está aguardando resposta do atendente (awaiting_human)."),
      409,
      { requestId },
    );
  }

  // Transição + nota + sino no MESMO commit. Um caso `cancelled` é terminal:
  // não há caminho de volta pela API, então meio efeito aplicado não teria
  // retentativa que se curasse — sobraria um caso fechado com o sino cobrando.
  const client = await pool.connect();
  // #2506: consulta que estoura o query_timeout rejeita sem destruir o socket
  // (pg 8.23). Liberado com release() sem erro, este cliente volta ao pool com a
  // transação antiga aberta e é reemprestado nela. O finally lê desta marcação.
  let erroNaTransacao: Error | undefined;
  let encerrado: boolean;
  try {
    await client.query("begin");
    encerrado = await encerrarChamadoPelaPessoa(client, org.orgId, caseId, user.id, note);
    if (encerrado) await client.query("commit");
    else await client.query("rollback");
  } catch (err) {
    erroNaTransacao = err instanceof Error ? err : new Error(String(err));
    await client.query("rollback");
    throw err;
  } finally {
    client.release(erroNaTransacao);
  }
  if (!encerrado) {
    // Corrida perdida entre a leitura e o update: outro atendente fechou.
    return fail("invalid_state", t("Este caso já foi respondido por outra pessoa."), 409, {
      requestId,
    });
  }

  await audit({
    action: "ai.case_closed_without_reply",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "agent_case",
    resourceId: caseId,
    requestId,
    metadata: { case_action: "closed_without_reply", outcome: "sem_necessidade" },
  });

  return ok({ status: "cancelled" }, { requestId });
}
