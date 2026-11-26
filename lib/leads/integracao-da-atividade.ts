/**
 * QUAL INTEGRAÇÃO agiu numa atividade do lead (#5160, item 2).
 *
 * ─── O defeito, medido na main `c45028c9c` ─────────────────────────────────
 *
 * Token de API mexe no negócio e a atividade nasce `actor_kind = 'system'`
 * (`actorParaAtividade`, `lib/leads/activity-emitter.ts`) sem nada na linha que
 * diga QUAL token agiu. O painel "Atividade" da conversa
 * (`components/inbox/CRMSidePanel.tsx`) desenhava "Sistema", o mesmo rótulo da
 * plataforma agindo sozinha. O `api_audit_log` guarda `actor_api_token_id`,
 * mas nenhuma tela de lead o lê.
 *
 * ─── Por que o id vai na linha e o nome é lido depois ──────────────────────
 *
 * A atividade nasce em dezenas de escritores, vários fora de request (sem o
 * client que lê `api_tokens`). Gravar o NOME exigiria cada um ler o token; o
 * id já está no `Actor`. Então a linha guarda o id em
 * `crm_lead_activities.metadata` (coluna que já existe) e quem lê resolve o
 * nome, como `nomesDosAtendentes` faz para pessoas. O balão de mensagem
 * (#5164) grava o nome porque o balão não tem rota própria que resolva.
 *
 * Módulo puro (sem `supabase`, sem `next`): serve ao emissor, à rota e ao
 * painel, para os três usarem o mesmo literal.
 */
export const CHAVE_DO_TOKEN_DA_ATIVIDADE = "actor_api_token_id";

/** O pedaço do `select` do PostgREST que traz só o id, nunca o `metadata` inteiro. */
export const SELECT_DO_TOKEN_DA_ATIVIDADE = `${CHAVE_DO_TOKEN_DA_ATIVIDADE}:metadata->>${CHAVE_DO_TOKEN_DA_ATIVIDADE}`;

/** O que o `crm-summary` devolve por linha: `null` quando não foi um token. */
export type IntegracaoDaAtividade = { nome: string | null } | null;

/** O id do token de uma linha lida com `SELECT_DO_TOKEN_DA_ATIVIDADE`. */
export function tokenDaAtividade(linha: Record<string, unknown>): string | null {
  const id = linha[CHAVE_DO_TOKEN_DA_ATIVIDADE];
  return typeof id === "string" && id.trim() ? id : null;
}

/**
 * "Integração · Zapier" ou "Integração". O nome nunca passa por `t()`: é dado
 * do operador (#1046/#3649 — traduzir dado muda o dado).
 */
export function autorDaIntegracao(
  integracao: { nome: string | null },
  t: (texto: string) => string = (texto) => texto,
): string {
  const nome = integracao.nome?.trim();
  return nome ? `${t("Integração")} · ${nome}` : t("Integração");
}
