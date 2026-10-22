/**
 * Os fatos que a Condição do módulo Automações (out/2026) consulta e que não
 * moram no lead: a hora e o dia no fuso da organização, o número que recebeu a
 * conversa, de onde o contato veio, se já é cliente e o DDD.
 *
 * Lido SÓ quando uma condição pede um destes campos (o motor confere antes), e
 * nunca lança por dado ausente: o que não se sabe volta `null`, e `null` não
 * satisfaz regra nenhuma (`evaluateCheck`).
 */
import { localMoment } from "@/lib/routing/eligibility";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { FatosDeContexto } from "./node-handlers";

type Admin = ReturnType<typeof createAdminClient>;

const FUSO_PADRAO = "America/Sao_Paulo";

/** DDD de um telefone brasileiro em E.164 (`+55 11 9…`). Outro país = `null`. */
export function dddDoTelefone(telefone: string | null | undefined): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "");
  if (!digitos.startsWith("55") || digitos.length < 12) return null;
  return digitos.slice(2, 4);
}

export function momentoNoFuso(agora: Date, fuso: string | null | undefined): { hora: number; dia: string } {
  let m: { dow: number; hhmm: string };
  try {
    m = localMoment(agora, fuso || FUSO_PADRAO);
  } catch {
    m = localMoment(agora, FUSO_PADRAO);
  }
  return { hora: Number(m.hhmm.slice(0, 2)), dia: String(m.dow) };
}

export async function carregarFatosDeContexto(
  admin: Admin,
  input: { organization_id: string; contact_id: string; conversation_id: string | null; agora: Date },
): Promise<FatosDeContexto> {
  const org = input.organization_id;
  const [orgRes, contatoRes, conversaRes, ganhoRes] = await Promise.all([
    admin.from("organizations").select("timezone").eq("id", org).maybeSingle(),
    admin
      .from("contacts")
      .select("phone_number, source_metadata, client_recognized_at")
      .eq("organization_id", org)
      .eq("id", input.contact_id)
      .maybeSingle(),
    input.conversation_id
      ? admin
          .from("conversations")
          .select("channel_session_id")
          .eq("organization_id", org)
          .eq("id", input.conversation_id)
          .maybeSingle()
      : admin
          .from("conversations")
          .select("channel_session_id")
          .eq("organization_id", org)
          .eq("contact_id", input.contact_id)
          .eq("is_group", false)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle(),
    admin
      .from("crm_leads")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("contact_id", input.contact_id)
      .eq("status", "won"),
  ]);

  const fuso = (orgRes.data as { timezone?: string | null } | null)?.timezone ?? null;
  const { hora, dia } = momentoNoFuso(input.agora, fuso);

  const contato = contatoRes.data as
    | { phone_number?: string | null; source_metadata?: unknown; client_recognized_at?: string | null }
    | null;
  const meta =
    contato?.source_metadata && typeof contato.source_metadata === "object" && !Array.isArray(contato.source_metadata)
      ? (contato.source_metadata as Record<string, unknown>)
      : {};
  const plataforma = typeof meta.ad_platform === "string" && meta.ad_platform.trim() ? meta.ad_platform.trim() : null;

  const jaComprou = (ganhoRes.count ?? 0) > 0 || Boolean(contato?.client_recognized_at);

  return {
    hora_do_dia: hora,
    dia_da_semana: dia,
    canal: (conversaRes.data as { channel_session_id?: string | null } | null)?.channel_session_id ?? null,
    origem: contato ? (plataforma ?? "organico") : null,
    cliente_recorrente: contato ? (jaComprou ? "sim" : "nao") : null,
    ddd: dddDoTelefone(contato?.phone_number),
  };
}
