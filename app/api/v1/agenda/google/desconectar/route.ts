import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DESCONECTAR A AGENDA DO GOOGLE.
 *
 * ─── Por que esta rota existe ─────────────────────────────────────────────
 *
 * A conexão se fazia pela tela e não se desfazia por lugar nenhum: só existiam
 * `connect` e `callback`. Medido — `ls app/api/v1/agenda/google/` devolvia dois
 * diretórios, e o prop `contaConectada` do cartão NUNCA era passado, então o
 * ramo "Agenda conectada" era código morto e o botão "Conectar Google" nunca
 * sumia depois de conectar.
 *
 * A casa remove credencial de IA e sessão de canal; só a do Google não saía.
 *
 * ─── O que ela APAGA, e por quê cada coisa ───────────────────────────────
 *
 * 1. Os TOKENS. `oauth_refresh_token_encrypted` é o que dá acesso contínuo à
 *    conta pessoal de alguém. Marcar `status` e deixar o segredo no banco seria
 *    desconectar de mentira.
 *
 * 2. Os CALENDÁRIOS (`calendar_connection_calendars`). É o que o cron itera; sem
 *    remover, ele segue tentando ler uma conexão que a pessoa desligou.
 *
 * 3. Os EVENTOS EXTERNOS (`calendar_external_events`), e esta é a parte que o
 *    `status` sozinho NÃO resolve. `lib/agenda/consulta.ts:243` lê a ocupação
 *    com `calendar_connections!inner(user_id, status)` e filtra **só por
 *    `user_id`** — o `status` vem no join e não entra no `where`. Então uma
 *    conexão `disconnected` continuaria bloqueando horário para sempre.
 *
 *    ⚠️ E filtrar `status` naquela consulta seria o conserto ERRADO: conexão
 *    DEFASADA precisa seguir bloqueando (é o "falha fechado na ação" que a
 *    DECISÃO 3.2 pede — na dúvida, não ofereça o horário). Defasada e
 *    desconectada são estados diferentes: uma parou de atualizar, a outra a
 *    pessoa removeu. Só a segunda pede que os bloqueios sumam.
 *
 * ─── Quem pode ────────────────────────────────────────────────────────────
 *
 * A própria pessoa desconecta a dela com `agent`. Desconectar a de OUTRO membro
 * exige `manager` — e é o caso que dá saída ao ex-funcionário: sem isto, a
 * agenda pessoal de quem saiu fica no banco sem via de produto que a apague.
 *
 * O `organization_id` vem SEMPRE da sessão, nunca do corpo. O corpo carrega no
 * máximo o `user_id` ALVO, e ele é validado pelo papel — não é o que decide o
 * tenant.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { PROVEDOR_GOOGLE } from "@/lib/agenda/tipos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpo = z.object({
  /** Ausente = a própria conexão de quem chamou. Presente = exige `manager`. */
  user_id: z.string().uuid().optional(),
});

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;

  const autorizado = await requireRole("agent", { requestId, resource: "calendar_connections" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  let alvo = user.id;
  const bruto = await req.json().catch(() => ({}));
  const lido = corpo.safeParse(bruto);
  if (!lido.success) {
    return fail("validation_failed", "Corpo inválido para desconectar.", 422, { requestId });
  }
  if (lido.data.user_id && lido.data.user_id !== user.id) {
    // Desconectar a agenda de OUTRA pessoa é ato de gestão, não de uso.
    const gestor = await requireRole("manager", { requestId, resource: "calendar_connections" });
    if (!gestor.ok) return gestor.response;
    alvo = lido.data.user_id;
  }

  const admin = createAdminClient();

  // Filtro explícito de tenant no client de service role — a doutrina não abre
  // exceção nem quando o `user_id` já restringiria na prática.
  const { data: conexoes, error: erroLeitura } = await admin
    .from("calendar_connections")
    .select("id, account_email")
    .eq("organization_id", org.orgId)
    .eq("user_id", alvo)
    // A CONSTANTE. Era `"google"`, e por isso desconectar respondia 404
    // "Não há agenda do Google conectada" para quem TINHA a agenda conectada.
    .eq("provider", PROVEDOR_GOOGLE);

  if (erroLeitura) {
    return fail("internal_error", erroLeitura.message, 500, { requestId });
  }
  if (!conexoes || conexoes.length === 0) {
    // 404 e não 200: dizer "desconectei" sobre o que não existe é a mesma
    // família de mentira que o "Marcado ✓" sem linha no banco.
    return fail("not_found", "Não há agenda do Google conectada para esta pessoa.", 404, {
      requestId,
    });
  }

  const ids = conexoes.map((c) => c.id);

  const { error: erroEventos } = await admin
    .from("calendar_external_events")
    .delete()
    .eq("organization_id", org.orgId)
    .in("connection_id", ids);
  if (erroEventos) return fail("internal_error", erroEventos.message, 500, { requestId });

  const { error: erroCalendarios } = await admin
    .from("calendar_connection_calendars")
    .delete()
    .eq("organization_id", org.orgId)
    .in("connection_id", ids);
  if (erroCalendarios) return fail("internal_error", erroCalendarios.message, 500, { requestId });

  const { error: erroConexao } = await admin
    .from("calendar_connections")
    .update({
      status: "disconnected",
      oauth_access_token_encrypted: null,
      oauth_refresh_token_encrypted: null,
      token_expires_at: null,
      sync_token: null,
      last_sync_error: null,
    })
    .eq("organization_id", org.orgId)
    .in("id", ids);
  if (erroConexao) return fail("internal_error", erroConexao.message, 500, { requestId });

  // UMA LINHA POR CONEXÃO, e não uma com `ids[0]`.
  //
  // `tests/unit/audit-resource-id-e-uuid.test.ts` reprovou o `ids[0]` — e estava
  // certo por um motivo de tipo (índice pode ser `undefined`, e `resource_id` é
  // uuid: um valor inválido faz o INSERT do audit estourar, e como audit é
  // fire-and-forget a mutação segue e a trilha perde a linha, sem sintoma em
  // tela nenhuma).
  //
  // Mas contornar o gate seria pior que o gate: com DUAS contas conectadas,
  // `ids[0]` é uma escolha arbitrária que descreve mal o que aconteceu. Uma
  // linha por conexão diz a verdade e devolve o `resource_id` que a auditoria
  // existe para carregar.
  for (const conexao of conexoes) {
    await audit({
      action: "agenda.google.conexao_desconectada",
      organizationId: org.orgId,
      resourceType: "calendar_connections",
      resourceId: conexao.id,
      metadata: { user_id: alvo, por: user.id, conta: conexao.account_email },
    });
  }

  return ok({ desconectadas: ids.length }, { requestId });
}
