/**
 * O relógio da trilha (docs/agencia/SPEC-trilhas.md, R10), chamado pelo cron
 * `agencia-prazos` que já roda a cada 15 min.
 *
 * Só olha os passos SEM tarefa — reunião por marcar e marco por confirmar —,
 * porque a tarefa já tem os avisos de prazo dela. Idempotente no banco:
 * `primary key (passo_id, marco)` em `agencia_avisos_de_trilha`, reservado
 * antes de avisar.
 */
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import type { TipoDeAviso } from "../avisos/tipos";
import { marcoDePrazo } from "../tarefas/regras";

const TIPO_DO_MARCO: Record<string, TipoDeAviso> = { no_dia: "prazo_hoje", atrasou: "prazo_atrasado" };

export async function avisarPrazosDaTrilha(agora: Date = new Date()): Promise<{ avisados: number }> {
  const db = createAdminClient();
  if (!(await moduloLigado(db, "agencia"))) return { avisados: 0 };
  const [{ data: config }, { data: passos }] = await Promise.all([
    db.from("agencia_config").select("avisos_antecedencia").eq("id", true).maybeSingle(),
    db
      .from("agencia_trilha_passos")
      .select("id, titulo, tipo, prazo, agencia_trilhas!inner(cliente_id, situacao, agencia_clientes(nome)), agencia_avisos_de_trilha(marco)")
      .in("situacao", ["liberado", "em_andamento"])
      .is("tarefa_id", null)
      .is("reuniao_id", null)
      .not("prazo", "is", null)
      .eq("agencia_trilhas.situacao", "ativa")
      .lte("prazo", new Date(agora.getTime() + 8 * 86_400_000).toISOString()),
  ]);
  const antecedencia = ((config as { avisos_antecedencia?: number[] } | null)?.avisos_antecedencia ?? [2, 1]).filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= 7,
  );

  let avisados = 0;
  for (const p of (passos ?? []) as unknown as Array<{
    id: string;
    titulo: string;
    tipo: string;
    prazo: string;
    agencia_trilhas: { cliente_id: string; agencia_clientes: { nome: string } | null };
    agencia_avisos_de_trilha: Array<{ marco: string }> | null;
  }>) {
    const marco = marcoDePrazo(new Date(p.prazo), antecedencia, agora);
    if (!marco || (p.agencia_avisos_de_trilha ?? []).some((a) => a.marco === marco)) continue;
    const { error } = await db.from("agencia_avisos_de_trilha").insert({ passo_id: p.id, marco });
    if (error) continue;
    const cliente = p.agencia_trilhas.agencia_clientes?.nome;
    const dias = marco.startsWith("antes_") ? Number(marco.slice(6, -1)) : 0;
    const quando =
      marco === "atrasou" ? "Atrasado" : marco === "no_dia" ? "Vence hoje" : `Vence em ${dias} dia${dias > 1 ? "s" : ""}`;
    await criarAviso({
      alvo: { tipo: "gerais" },
      tipo: TIPO_DO_MARCO[marco] ?? "prazo_chegando",
      titulo: `${quando}: ${p.tipo === "reuniao" ? "marcar " : ""}${p.titulo}${cliente ? ` — ${cliente}` : ""}`,
      link: `/agencia/trilhas/${p.agencia_trilhas.cliente_id}`,
      referenciaId: p.id,
    });
    avisados++;
  }
  return { avisados };
}
