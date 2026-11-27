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

/**
 * O que o `crm-summary` devolve por linha: `null` quando não foi um token desta
 * organização (ou o token não pôde ser lido) — a linha segue o rótulo do ator.
 */
export type IntegracaoDaAtividade = { nome: string | null } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O id do token que entra na linha, ou `null`.
 *
 * Só UUID: vários escritores internos usam o ator `api_token` com um rótulo no
 * `id` (`cron:proposal-expiry`, `proposal:send`, `amigo-sync`,
 * `amigo-reminder-check`). Esses não são integração nenhuma e seguem como
 * "Sistema"; gravá-los faria a tela dizer "Integração" e, na leitura, um valor
 * que não é UUID derrubaria a consulta de `api_tokens` da janela inteira.
 */
export function tokenDoAtor(actor: { type: string; id?: unknown }): string | null {
  if (actor.type !== "api_token") return null;
  return typeof actor.id === "string" && UUID.test(actor.id) ? actor.id : null;
}

/** O id do token de uma linha lida com `SELECT_DO_TOKEN_DA_ATIVIDADE` (só UUID). */
export function tokenDaAtividade(linha: Record<string, unknown>): string | null {
  const id = linha[CHAVE_DO_TOKEN_DA_ATIVIDADE];
  return typeof id === "string" && UUID.test(id) ? id : null;
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
