import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { agendaSettingsSchema } from "@/lib/schemas/settings";
import { logger } from "@/lib/logger";

export interface CompromissoProtetor {
  id: string;
  contact_id: string | null;
  revision: number;
  starts_at: string;
  ends_at: string;
  status: string;
}
export type ProtecaoAgenda = {
  adiar: boolean;
  motivo:
    | "sem_compromisso"
    | "agendado"
    | "em_atendimento"
    | "presenca_pendente"
    | "presenca_vencida"
    | "leitura_indisponivel";
  appointment_id: string | null;
  reavaliar_em: string | null;
};
export function protecaoDaAgenda(
  compromissos: CompromissoProtetor[],
  settings: unknown,
  agora: Date,
): ProtecaoAgenda {
  const config = agendaSettingsSchema.parse(settings);
  const agoraMs = agora.getTime();
  const vivos = compromissos.filter((a) => a.status === "pending" || a.status === "confirmed");
  let vencido: CompromissoProtetor | undefined;
  for (const a of vivos.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    const inicio = Date.parse(a.starts_at),
      fim = Date.parse(a.ends_at);
    const horizonte = fim + config.unknown_protection_minutes * 60_000;
    if (agoraMs >= horizonte) {
      vencido ??= a;
      continue;
    }
    return {
      adiar: true,
      motivo:
        agoraMs < inicio ? "agendado" : agoraMs < fim ? "em_atendimento" : "presenca_pendente",
      appointment_id: a.id,
      reavaliar_em: new Date(
        Math.min(horizonte, Math.max(agoraMs + 60_000, agoraMs < inicio ? inicio : fim)),
      ).toISOString(),
    };
  }
  return {
    adiar: false,
    motivo: vencido ? "presenca_vencida" : "sem_compromisso",
    appointment_id: vencido?.id ?? null,
    reavaliar_em: null,
  };
}
function indisponivel(agora: Date): ProtecaoAgenda {
  logger.warn("[agenda] proteção indisponível; cobrança adiada");
  return {
    adiar: true,
    motivo: "leitura_indisponivel",
    appointment_id: null,
    reavaliar_em: new Date(agora.getTime() + 60_000).toISOString(),
  };
}
export async function protecaoAgendaSupabase(
  db: SupabaseClient,
  org: string,
  contatos: string[],
  agora = new Date(),
): Promise<Map<string, ProtecaoAgenda>> {
  if (!contatos.length) return new Map();
  try {
    const appointments: CompromissoProtetor[] = [];
    let after: string | undefined;
    // Keyset estável: uma resposta bem-sucedida pode ter sido truncada pelo
    // max_rows do PostgREST. Só página VAZIA prova que a leitura terminou.
    for (;;) {
      let query = db
        .from("calendar_appointments")
        .select("id,contact_id,revision,starts_at,ends_at,status")
        .eq("organization_id", org)
        .in("contact_id", contatos)
        .in("status", ["pending", "confirmed"])
        .order("id", { ascending: true })
        .limit(500);
      if (after) query = query.gt("id", after);
      const page = await query;
      if (page.error) throw page.error;
      if (!page.data?.length) break;
      const last = page.data[page.data.length - 1]!.id;
      if (after && last <= after) throw new Error("agenda_page_did_not_advance");
      appointments.push(...page.data);
      after = last;
    }
    const organization = await db.from("organizations").select("settings").eq("id", org).single();
    if (organization.error) throw organization.error;
    return new Map(
      contatos.map((id) => [
        id,
        protecaoDaAgenda(
          appointments.filter((a) => a.contact_id === id),
          organization.data.settings?.agenda,
          agora,
        ),
      ]),
    );
  } catch {
    return new Map(contatos.map((id) => [id, indisponivel(agora)]));
  }
}
export async function protecaoAgendaPg(
  db: Queryable,
  org: string,
  contact: string,
  agora = new Date(),
): Promise<ProtecaoAgenda> {
  try {
    const [appointments, organization] = await Promise.all([
      db.query<CompromissoProtetor>(
        "select id,contact_id,revision::float8,starts_at::text,ends_at::text,status from calendar_appointments where organization_id=$1 and contact_id=$2 and status in ('pending','confirmed')",
        [org, contact],
      ),
      db.query<{ settings: { agenda?: unknown } }>(
        "select settings from organizations where id=$1",
        [org],
      ),
    ]);
    if (!organization.rows[0]) throw new Error("agenda_org_missing");
    return protecaoDaAgenda(appointments.rows, organization.rows[0].settings?.agenda, agora);
  } catch {
    return indisponivel(agora);
  }
}
export class AgendaDeferredError extends Error {
  constructor(public readonly protection: ProtecaoAgenda) {
    super(`agenda:${protection.motivo}`);
    this.name = "AgendaDeferredError";
  }
}
