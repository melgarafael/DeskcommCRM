/**
 * O PEDIDO QUE NINGUÉM DECIDIU LIBERA O HORÁRIO.
 *
 * Um tipo de agendamento com `requires_confirmation` cria o compromisso em
 * `pending`, e `pending` OCUPA o horário — medido: o slot some da lista de
 * livres e uma segunda marcação no mesmo horário é recusada com
 * `agenda_horario_indisponivel`. É a garantia que faz o modo "o cliente pede, uma
 * pessoa confirma" funcionar: entre o pedido e a conferência, ninguém mais leva
 * aquele horário.
 *
 * O que faltava é o outro lado dessa garantia. Sem expiração, **indecisão vira
 * horário travado para sempre**: o pedido que ninguém abriu segura a agenda por
 * semanas, e o efeito é indistinguível de agenda cheia — o próximo cliente ouve
 * "não tenho horário" por causa de um pedido abandonado.
 *
 * ═══ O PRAZO É EM HORAS, E NÃO "A VIRADA DO DIA" ═══
 *
 * A especificação de origem dizia "expira na virada do dia". Não segui, e o
 * motivo é medido: aquela regra vinha de duas migrations que **nunca foram
 * aplicadas** no sistema de origem — ela nunca rodou, então não há comportamento
 * a preservar, só uma escolha a fazer.
 *
 * E ela tem um defeito que só aparece no uso: um pedido feito às 23h expiraria
 * em uma hora, de madrugada, antes de qualquer pessoa acordar para decidir. O
 * prazo em horas trata todo pedido igual, independentemente da hora em que
 * chegou.
 *
 * `pending_expires_after_minutes` é por organização, com default de 24h — quem
 * confere a fila uma vez por dia não perde nada.
 *
 * ═══ O QUE ESTA ROTA NÃO FAZ ═══
 *
 * **Não fala com o cliente.** Expirar é operação interna: a pessoa pediu, não
 * confirmaram, e o horário voltou para a prateleira. Mandar "seu pedido
 * expirou" é uma decisão de produto diferente, e cara — seria a primeira
 * mensagem automática do sistema a dar má notícia.
 *
 * **Não fecha o caso.** O pedido do cliente vive em `agent_cases`, que é outra
 * coisa: quem confere continua vendo que alguém pediu horário, e pode remarcar.
 * O que expira é a RESERVA, não o pedido.
 *
 * **Não toca no que já foi decidido.** Só `pending`. `confirmed`, `cancelled`,
 * `completed` e `no_show` estão fora do filtro — e o `.eq("status","pending")`
 * do UPDATE é a segunda barreira, para o caso de alguém confirmar entre a
 * leitura e a escrita.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { agendaSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Teto por rodada. A varredura roda a cada 15 min; sobra volta na seguinte. */
const LIMITE_DA_VARREDURA = 500;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // O prazo é POR ORGANIZAÇÃO, então a varredura não pode usar um corte único
  // de `created_at` no SQL. Busca os pendentes de todas as orgs e aplica o prazo
  // de cada uma — o volume é pequeno por construção (pendente é estado curto).
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("id, organization_id, created_at, starts_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[agenda-expira-pendentes] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar pendentes.", 500, { requestId });
  }

  const linhas = data ?? [];
  if (linhas.length === 0) {
    return ok({ examinados: 0, expirados: 0, mantidos: 0 }, { requestId });
  }

  // Um SELECT por organização presente, não um por linha.
  const orgs = [...new Set(linhas.map((l) => l.organization_id))];
  const { data: configs } = await admin
    .from("organizations")
    .select("id, settings")
    .in("id", orgs);

  const prazoPorOrg = new Map<string, number>();
  for (const o of configs ?? []) {
    const s = (o.settings as { agenda?: unknown } | null)?.agenda;
    prazoPorOrg.set(o.id, agendaSettingsSchema.parse(s ?? {}).pending_expires_after_minutes);
  }

  const expirados: string[] = [];
  let mantidos = 0;
  for (const linha of linhas) {
    const prazo = prazoPorOrg.get(linha.organization_id);
    if (prazo === undefined) {
      // Organização que sumiu entre as duas consultas: não decide nada por ela.
      mantidos += 1;
      continue;
    }
    const nasceu = Date.parse(linha.created_at);
    if (Number.isNaN(nasceu) || nasceu + prazo * 60_000 > agora.getTime()) {
      mantidos += 1;
      continue;
    }
    expirados.push(linha.id);
  }

  if (expirados.length === 0) {
    return ok({ examinados: linhas.length, expirados: 0, mantidos }, { requestId });
  }

  // `.eq("status","pending")` de novo: se alguém confirmou entre a leitura e
  // aqui, o UPDATE não alcança a linha — e é isso que se quer. Cancelar um
  // compromisso que acabou de ser confirmado seria o pior desfecho possível
  // desta rota.
  const { data: efetivados, error: erroUpdate } = await admin
    .from("calendar_appointments")
    .update({
      status: "cancelled",
      cancellation_reason: "Pedido expirado: ninguém confirmou dentro do prazo.",
    })
    .in("id", expirados)
    .eq("status", "pending")
    .select("id");

  if (erroUpdate) {
    logger.error("[agenda-expira-pendentes] update falhou", {
      error: erroUpdate.message,
      tentados: expirados.length,
      requestId,
    });
    return fail("internal_error", "Falha ao expirar pendentes.", 500, { requestId });
  }

  const quantos = efetivados?.length ?? 0;

  // Rodada que não expirou nada NÃO é mutação e não audita — a lei está no
  // CLAUDE.md §Audit log, e `cron-audita-so-quando-ha-efeito.test.ts` varre o
  // AST desta pasta atrás de `audit` incondicional.
  if (quantos > 0) {
    await audit({
      action: "agenda.pendente_expirado",
      resourceType: "calendar_appointment",
      requestId,
      metadata: { expirados: quantos, examinados: linhas.length },
    });
  }

  return ok(
    { examinados: linhas.length, expirados: quantos, mantidos },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
