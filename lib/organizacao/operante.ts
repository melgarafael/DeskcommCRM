/**
 * "ORG OPERANTE" — a régua ÚNICA de "esta empresa pode operar?"
 * (docs/superpowers/specs/2026-09-29-cobranca-do-revendedor-design.md §4).
 *
 * operante ⇔ organizations.status = 'active'. Espelho SQL:
 * `public.fn_org_operante(uuid)` (migration 0501). Mesma régua dos porteiros SQL
 * que já existiam (fn_accept_team_invite, fn_reply_delivery_policy,
 * fn_meet_delivery_current). `suspended`, `redacted`, `archived` e qualquer
 * status futuro ficam NÃO operantes: falha fechada.
 *
 * ── Leitura de `suspended_kind` ──────────────────────────────────────────────
 * Só significa algo com status='suspended'. O lgpd-redact-worker troca o status
 * para 'redacted' sem limpar o tipo, e por isso o banco NÃO tem CHECK de
 * coerência entre as duas colunas: quem lê o tipo confere antes que o status é
 * 'suspended' — "parada" não basta, a redigida também é parada. Suspensão com tipo NULO (gravada por uma imagem anterior à 0501,
 * depois de um rollback) vale como `administrativa`, como nas funções de estado.
 *
 * ── Deliberadamente NÃO gatilhados (spec §4, decisões D-11 e D-12) ───────────
 * - webhooks de entrada de canal (as rotas `<canal>/[token]` e `channel/[token]`,
 *   e a rota global do canal, sem token),
 *   in/[token], channels/official/webhook, nuvemshop/[event] e
 *   lib/channels/inbound.ts — a mensagem que CHEGA continua gravada;
 * - landings anuncios/{google,meta}/[org] e rastreio/[id] (D-11);
 * - recover-stuck-messages; sync/push do Google Agenda; contact-avatars;
 * - leitura via RLS, Realtime e Storage;
 * - escrita de dados de negócio via PostgREST por membro de org suspensa (D-12);
 * - LGPD: nunca bloqueada (requireRole({ permiteOrgSuspensa: true }), e no MCP a
 *   ferramenta de privacidade — `lib/mcp/tools/privacidade.ts`).
 *
 * Este módulo NÃO importa `next/*` nem `server-only`: o dreno do event_log e o
 * do agent-engine o carregam sob `tsx` no worker
 * (tests/unit/drain-loop-carrega-deps-sob-tsx.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";

export const STATUS_OPERANTE = "active" as const;

/** Por que a organização está suspensa. Par de `organizations_suspended_kind_check` (0501). */
export const TIPOS_DE_SUSPENSAO = ["administrativa", "cobranca"] as const;
export type TipoDeSuspensao = (typeof TIPOS_DE_SUSPENSAO)[number];

export function ehOperante(status: string | null | undefined): boolean {
  return status === STATUS_OPERANTE;
}

/**
 * A organização está SUSPENSA (e não só "parada"): `redacted`/`archived` também não
 * operam, mas não são suspensões. Quem decide "só a suspensa pode X" (excluir pelo
 * painel, reativar) pergunta aqui, para a comparação com o texto morar num lugar só.
 */
export function estaSuspensa(status: string | null | undefined): boolean {
  return status === "suspended";
}

/**
 * Por que a organização está suspensa, ou `null` quando ela não está suspensa
 * (inclusive redigida ou arquivada com o tipo residual). Tipo nulo em org
 * suspensa vale como `administrativa`, como nas funções de estado. A comparação
 * com o literal da suspensão mora em `estaSuspensa`.
 */
export function tipoDaSuspensao(
  status: string | null | undefined,
  kind: string | null | undefined,
): TipoDeSuspensao | null {
  if (!estaSuspensa(status)) return null;
  return kind === "cobranca" ? "cobranca" : "administrativa";
}

/**
 * A organização não opera. `ApiError` 403 `org_suspended`: a rota /messages o
 * traduz em resposta (app/api/v1/messages/route.ts) e o agent-worker cancela sem
 * retry quem tem `terminal === true` (workers/agent-worker/main.ts,
 * `ehVetoPermanenteDeNegocio`) — a org parada não volta a operar sozinha.
 * `orgStatus`, e não `status`: `status` é o HTTP herdado de `ApiError`.
 */
export class OrgNaoOperanteError extends ApiError {
  readonly terminal = true as const;
  constructor(
    readonly organizationId: string,
    readonly orgStatus: string | null = null,
  ) {
    super(403, "org_suspended", undefined, "", "A conta desta empresa está suspensa.");
    this.name = "OrgNaoOperanteError";
  }
}

/** Ids das orgs NÃO operantes, para excluir de varreduras (crons, workers). Erro de leitura lança. */
export async function idsDeOrgsParadas(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from("organizations").select("id").neq("status", STATUS_OPERANTE);
  if (error) throw new Error(`idsDeOrgsParadas: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((linha) => linha.id);
}

/**
 * O status embutido por `organizations:organization_id!inner(status)` — o
 * PostgREST devolve objeto ou array conforme a cardinalidade inferida, e quem lê
 * não deve se prender a um dos dois. É o par da régua SQL `fn_org_operante`: em
 * vez de buscar a lista de ids das orgs paradas e negar `in (...)` na URL (que
 * cresce sem teto e corta em `max_rows` sem aviso), as varreduras embutem o
 * status com `!inner`, filtram `organizations.status = STATUS_OPERANTE` na
 * própria consulta (o corte sai ANTES do `limit`) e ainda passam `ehOperante`
 * linha a linha, como cinto.
 *
 * O `:organization_id` fixa a relação pela coluna: uma tabela com FK para as
 * duas pontas na chave primária (ex.: `appointment_recovery_receipts`) pode
 * fazer o PostgREST enxergar um muitos-para-muitos e recusar o embed por nome.
 */
export function statusDaOrgEmbutida(
  embutida: { status?: string | null } | Array<{ status?: string | null }> | null | undefined,
): string | null | undefined {
  if (!embutida) return undefined;
  return Array.isArray(embutida) ? embutida[0]?.status : embutida.status;
}

/** Lança `OrgNaoOperanteError` se a org não opera (inclusive se não aparece). Erro de leitura lança erro comum. */
export async function assertOrgOperante(db: SupabaseClient, orgId: string): Promise<void> {
  const { data, error } = await db.from("organizations").select("status").eq("id", orgId).maybeSingle();
  if (error) throw new Error(`assertOrgOperante: ${error.message}`);
  const status = (data as { status?: string } | null)?.status ?? null;
  if (!ehOperante(status)) throw new OrgNaoOperanteError(orgId, status);
}
