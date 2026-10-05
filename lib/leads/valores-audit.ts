/**
 * O antes-e-depois que a auditoria de `lead.updated` passou a guardar — e SÓ
 * ele (issue #1755).
 *
 * ─── Por que isto existe ─────────────────────────────────────────────────────
 * O comentário da timeline prometia que "quem precisa do valor anterior tem
 * `api_audit_log`", mas o audit de `lead.updated` gravava apenas `{ fields }`
 * (os NOMES dos campos). A saída (a) da #1755 corrigiu a promessa; esta é a
 * saída (b): passar a gravar o antes-e-depois — dos campos tipados sem PII.
 *
 * ─── Evidência de que a casa JAMAIS tratou isso como proibido ────────────────
 * Gravar par antes/depois em `api_audit_log` é prática corrente aqui:
 *   - `lead.moved` grava `from_stage_id` / `to_stage_id`
 *     (app/api/v1/leads/_handler.ts);
 *   - `ai.budget_limit_changed` grava `enforcement_mode`,
 *     `monthly_limit_cents` e `alarm_threshold_pct` como `{ antes, depois }`
 *     (app/api/v1/ai/budget/route.ts);
 *   - `contact.field_confirmed` grava `old_value` / `new_value`
 *     (app/api/v1/contacts/[id]/proposals/[proposal_id]/route.ts).
 *
 * ─── Por que a lista é FECHADA, e branca em vez de preta ────────────────────
 * `api_audit_log` é append-only para os papéis do PostgREST (migration 0258) e
 * a anonimização da LGPD NÃO o reescreve: a cascata só INSERE uma linha
 * `lgpd.redact_executed` (migration 0019, passo 8) — `lib/lgpd/cascata.ts`
 * trabalha as tabelas de negócio. O que entrar aqui só sai pelo expurgo de
 * retenção (L-10: 5 anos, `fn_expurgar_auditoria_vencida`, migration 0167).
 * PII gravada aqui, portanto, fica legível até lá, sob controle de acesso.
 *
 * É por isso que a regra é uma LISTA e não um "menos PII": `title` é o NOME
 * DO CLIENTE neste produto, `description` é texto livre, `custom_fields` é dado
 * arbitrário do tenant sem limite conhecido e `tags` é vocabulário livre. Nenhum
 * deles é "campo tipado" — e acrescentar coluna de texto aqui é somar PII à
 * lista, não estender a regra.
 *
 * `stage_id` e `status` não aparecem: este PATCH não os altera (etapa e
 * desfecho passam por /move /win /lose), e o antes-e-depois da etapa já é
 * gravado por `lead.moved` (`from_stage_id`/`to_stage_id`).
 */

/** Colunas tipadas, sem PII de titular, cujo par antes/depois pode ir para o audit. */
export const CAMPOS_TIPADOS_SEM_PII = [
  "value_cents",
  "currency",
  "owner_user_id",
  "owner_agent_id",
  "expected_close_date",
] as const;

export interface ValorAntesDepois {
  antes: unknown;
  depois: unknown;
}

/**
 * O par antes/depois de cada campo TIPADO que esta requisição alterou.
 *
 * `camposAlterados` vem de `camposAlterados(camposDaAuditoria, existing)` — é
 * ele que decide o que mudou de verdade (o dossiê manda o form inteiro). Campo
 * tipado fora dessa lista não devolve nada; campo da lista sem mudança também
 * não. O vazio é omitido no chamador: linha de audit igual à de antes, quando
 * a edição foi só de texto.
 */
export function valoresAntesDepois(
  camposEnviados: Record<string, unknown>,
  estadoAnterior: Record<string, unknown>,
  camposAlterados: readonly string[],
): Record<string, ValorAntesDepois> {
  const valores: Record<string, ValorAntesDepois> = {};
  for (const campo of CAMPOS_TIPADOS_SEM_PII) {
    if (!camposAlterados.includes(campo)) continue;
    valores[campo] = {
      antes: estadoAnterior[campo] ?? null,
      depois: camposEnviados[campo] ?? null,
    };
  }
  return valores;
}
