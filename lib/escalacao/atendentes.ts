/**
 * Quem pode assumir uma conversa agora — a regra, num lugar só.
 *
 * Ela morava dentro de `app/api/v1/attendants/availability/route.ts` e servia só
 * ao painel de gestão. O agente escalava às cegas: chamava uma pessoa sem saber
 * se havia alguém online, com folga e dentro do horário — e a conversa caía numa
 * fila que ninguém ia puxar. Escalar para o vazio é pior que não escalar, porque
 * o cliente é avisado de que "uma pessoa vai assumir".
 *
 * Extraído (Decisão 4 do briefing IA 360) para que a rota e a capacidade do agente
 * leiam o MESMO roster. A elegibilidade em si continua sendo `isAttendantEligible`
 * (lib/routing/eligibility) — o mesmo predicado do worker de roteamento; aqui só
 * se junta o roster ao cálculo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { isAttendantEligible, OPEN_LOAD_STATUSES } from "@/lib/routing/eligibility";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

const COLUNAS_DISPONIBILIDADE =
  "user_id, is_available, capacity, schedule, last_heartbeat_at, updated_at";

export interface AtendenteDoRoster {
  userId: string;
  papel: Role;
  disponivel: boolean;
  /** null quando a pessoa nunca configurou disponibilidade. */
  capacidade: number | null;
  agenda: unknown;
  ultimoSinalDeVida: string | null;
  atualizadoEm: string | null;
  /** Conversas abertas atribuídas — mesma contagem que o worker de roteamento usa. */
  cargaAtual: number;
}

/**
 * O roster de atendimento da organização (agent+), com carga.
 *
 * Service role e filtro `organization_id` explícito por doutrina: a RLS de
 * `user_organizations` deixa manager ver só a própria linha, então listar a
 * equipe pelo client do usuário devolveria uma linha só.
 */
export async function carregarRosterDeAtendimento(
  admin: SupabaseClient,
  organizationId: string,
): Promise<AtendenteDoRoster[]> {
  const { data: members, error: mErr } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .is("revoked_at", null);
  if (mErr) throw new Error(mErr.message);

  // Atendentes = agent+ (viewer não é insumo de roteamento).
  const atendentes = ((members ?? []) as Array<{ user_id: string; role: Role }>).filter(
    (m) => ROLE_RANK[m.role] >= ROLE_RANK.agent,
  );
  const userIds = atendentes.map((m) => m.user_id);
  if (userIds.length === 0) return [];

  const { data: availData, error: aErr } = await admin
    .from("attendant_availability")
    .select(COLUNAS_DISPONIBILIDADE)
    .eq("organization_id", organizationId)
    .in("user_id", userIds);
  if (aErr) throw new Error(aErr.message);
  type LinhaDisponibilidade = {
    user_id: string;
    is_available: boolean;
    capacity: number;
    schedule: unknown;
    last_heartbeat_at: string | null;
    updated_at: string | null;
  };
  const porUsuario = new Map(
    ((availData ?? []) as LinhaDisponibilidade[]).map((a) => [a.user_id, a] as const),
  );

  const { data: openConvs, error: loadErr } = await admin
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", organizationId)
    .in("assigned_to_user_id", userIds)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  if (loadErr) throw new Error(loadErr.message);
  const cargaPorUsuario = new Map<string, number>();
  for (const c of (openConvs ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) {
      cargaPorUsuario.set(
        c.assigned_to_user_id,
        (cargaPorUsuario.get(c.assigned_to_user_id) ?? 0) + 1,
      );
    }
  }

  return atendentes.map((m) => {
    const a = porUsuario.get(m.user_id);
    return {
      userId: m.user_id,
      papel: m.role,
      disponivel: a?.is_available ?? false,
      capacidade: a?.capacity ?? null,
      agenda: a?.schedule ?? { timezone: "America/Sao_Paulo", windows: [] },
      ultimoSinalDeVida: a?.last_heartbeat_at ?? null,
      atualizadoEm: a?.updated_at ?? null,
      cargaAtual: cargaPorUsuario.get(m.user_id) ?? 0,
    };
  });
}

/**
 * Consegue receber uma conversa AGORA? Mesmo predicado do worker de roteamento —
 * disponível ∧ com folga ∧ dentro do horário.
 *
 * Quem nunca configurou disponibilidade tem `capacidade` null: isso é "não
 * configurado", e o worker o trata como fora (só entram linhas de
 * `attendant_availability` com `is_available`). Responder true aqui faria o
 * agente prometer um atendente que o roteamento nunca escolheria.
 */
export function podeAssumirAgora(atendente: AtendenteDoRoster, now: Date): boolean {
  if (atendente.capacidade === null) return false;
  return isAttendantEligible(
    {
      isAvailable: atendente.disponivel,
      capacity: atendente.capacidade,
      currentLoad: atendente.cargaAtual,
      schedule: availabilityScheduleSchema.parse(atendente.agenda ?? {}),
    },
    now,
  );
}
