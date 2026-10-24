/**
 * Os lembretes das reuniões (docs/agencia/SPEC-calendario.md, K7), chamados
 * pelo relógio que já existe — o cron `agencia-prazos`, a cada 15 min. Sem cron
 * novo: o agendador não precisa ser reconstruído.
 *
 * Idempotente no banco: `primary key (reuniao_id, marco)` em
 * `agencia_lembretes_de_reuniao`, reservado ANTES de avisar.
 */
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import { horaLocal, lembretesQueVencem, rotuloDoLembrete } from "./regras";

/** O maior marco que a tela oferece (1 semana): olhar além disso é desperdício. */
const HORIZONTE_MS = 7 * 86_400_000 + 3_600_000;

export async function avisarLembretesDeReuniao(agora: Date = new Date()): Promise<{ lembrados: number }> {
  const db = createAdminClient();
  if (!(await moduloLigado(db, "agencia"))) return { lembrados: 0 };
  const [{ data: config }, { data: reunioes }] = await Promise.all([
    db.from("agencia_config").select("reunioes_lembretes").eq("id", true).maybeSingle(),
    db
      .from("agencia_reunioes")
      .select("id, titulo, inicio, horario_em, meet_url, agencia_reunioes_membros(membro_id), agencia_lembretes_de_reuniao(marco)")
      .eq("situacao", "marcada")
      .gt("inicio", agora.toISOString())
      .lte("inicio", new Date(agora.getTime() + HORIZONTE_MS).toISOString()),
  ]);
  const marcos = ((config as { reunioes_lembretes?: number[] } | null)?.reunioes_lembretes ?? [1440, 60]).filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  if (marcos.length === 0) return { lembrados: 0 };

  let lembrados = 0;
  for (const r of (reunioes ?? []) as Array<{
    id: string;
    titulo: string;
    inicio: string;
    horario_em: string;
    meet_url: string | null;
    agencia_reunioes_membros: Array<{ membro_id: string }> | null;
    agencia_lembretes_de_reuniao: Array<{ marco: string }> | null;
  }>) {
    const feitos = (r.agencia_lembretes_de_reuniao ?? []).map((l) => l.marco);
    const v = lembretesQueVencem({ inicio: r.inicio, horarioEm: r.horario_em }, marcos, feitos, agora);
    if (v.enviar === null) continue;
    // Reserva os marcos ANTES de avisar: se dois crons correrem juntos, só um passa.
    const { error } = await db
      .from("agencia_lembretes_de_reuniao")
      .insert(v.registrar.map((m) => ({ reuniao_id: r.id, marco: String(m) })));
    if (error) continue;
    const membros = (r.agencia_reunioes_membros ?? []).map((m) => m.membro_id);
    if (membros.length === 0) continue;
    await criarAviso({
      alvo: { tipo: "membros", ids: membros },
      tipo: "reuniao_lembrete",
      titulo: `Reunião ${rotuloDoLembrete(v.enviar)}, às ${horaLocal(r.inicio)}: ${r.titulo}`,
      corpo: r.meet_url ? `Link: ${r.meet_url}` : null,
      link: `/agencia/calendario?abrir=${r.id}`,
      referenciaId: r.id,
    });
    lembrados++;
  }
  return { lembrados };
}
