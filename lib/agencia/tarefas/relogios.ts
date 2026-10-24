/**
 * Os dois relógios das tarefas da agência (docs/agencia/SPEC-tarefas.md, T8–T10),
 * chamados pelas rotas de cron `agencia-recorrentes` e `agencia-prazos`.
 *
 * Os dois são idempotentes no banco, não na memória: a recorrência tem
 * `unique (recorrente_id, gerada_para)` e o aviso de prazo tem
 * `primary key (tarefa_id, marco)`. Rodar duas vezes no mesmo minuto não gera
 * tarefa nem aviso em dobro.
 */
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import type { TipoDeAviso } from "../avisos/tipos";
import { marcoDePrazo, proximaExecucao, type Recorrencia } from "./regras";
import type { Padrao } from "./vocabulario";

interface LinhaRecorrente {
  id: string;
  titulo: string;
  descricao: string | null;
  cliente_id: string | null;
  funcao_id: string | null;
  prioridade: string;
  padrao: Padrao;
  dias_semana: number[];
  dia_do_mes: number | null;
  hora: string;
  prazo_em_horas: number | null;
  inicio: string;
  fim: string | null;
  proxima_execucao: string | null;
  agencia_recorrentes_responsaveis: Array<{ membro_id: string }> | null;
  agencia_recorrentes_etiquetas: Array<{ etiqueta_id: string }> | null;
}

export function recorrenciaDaLinha(l: Pick<LinhaRecorrente, "padrao" | "dias_semana" | "dia_do_mes" | "hora" | "inicio" | "fim">): Recorrencia {
  return { padrao: l.padrao, diasSemana: l.dias_semana, diaDoMes: l.dia_do_mes, hora: l.hora, inicio: l.inicio, fim: l.fim };
}

/** Gera as tarefas das recorrências vencidas. Devolve quantas nasceram. */
export async function gerarRecorrentes(agora: Date = new Date()): Promise<{ geradas: number }> {
  const db = createAdminClient();
  if (!(await moduloLigado(db, "agencia"))) return { geradas: 0 };
  const { data } = await db
    .from("agencia_tarefas_recorrentes")
    .select("*, agencia_recorrentes_responsaveis(membro_id), agencia_recorrentes_etiquetas(etiqueta_id)")
    .eq("ativa", true)
    .lte("proxima_execucao", agora.toISOString());

  let geradas = 0;
  for (const r of (data ?? []) as LinhaRecorrente[]) {
    if (!r.proxima_execucao) continue;
    const instante = new Date(r.proxima_execucao);
    const responsaveis = (r.agencia_recorrentes_responsaveis ?? []).map((x) => x.membro_id);
    const { data: nova, error } = await db
      .from("agencia_tarefas")
      .insert({
        titulo: r.titulo,
        descricao: r.descricao,
        cliente_id: r.cliente_id,
        funcao_id: r.funcao_id,
        prioridade: r.prioridade,
        coluna: "a_fazer",
        posicao: instante.getTime() / 1000,
        prazo: r.prazo_em_horas ? new Date(instante.getTime() + r.prazo_em_horas * 3600_000).toISOString() : null,
        recorrente_id: r.id,
        gerada_para: instante.toISOString(),
      })
      .select("id")
      .single();
    // 23505 = já gerada para este instante (o cron rodou de novo): só avança o relógio.
    if (error && error.code !== "23505") {
      logger.warn("agência: recorrente não gerou", { recorrente: r.id, codigo: error.code });
      continue;
    }
    if (nova) {
      const id = (nova as { id: string }).id;
      geradas++;
      if (responsaveis.length) await db.from("agencia_tarefas_responsaveis").insert(responsaveis.map((membro_id) => ({ tarefa_id: id, membro_id })));
      const etiquetas = (r.agencia_recorrentes_etiquetas ?? []).map((x) => x.etiqueta_id);
      if (etiquetas.length) await db.from("agencia_tarefas_etiquetas").insert(etiquetas.map((etiqueta_id) => ({ tarefa_id: id, etiqueta_id })));
      let alvos = responsaveis;
      if (alvos.length === 0 && r.funcao_id) {
        const { data: mf } = await db
          .from("agencia_membros_funcoes")
          .select("membro_id, agencia_membros!inner(situacao)")
          .eq("funcao_id", r.funcao_id)
          .eq("agencia_membros.situacao", "ativo");
        alvos = ((mf ?? []) as Array<{ membro_id: string }>).map((x) => x.membro_id);
      }
      if (alvos.length) {
        await criarAviso({
          alvo: { tipo: "membros", ids: alvos },
          tipo: "tarefa_atribuida",
          titulo: r.titulo,
          corpo: "Tarefa recorrente do dia.",
          link: `/agencia/tarefas?abrir=${id}`,
          referenciaId: id,
        });
      }
    }
    const proxima = proximaExecucao(recorrenciaDaLinha(r), instante);
    await db
      .from("agencia_tarefas_recorrentes")
      .update({ ultima_execucao: instante.toISOString(), proxima_execucao: proxima?.toISOString() ?? null, ativa: proxima !== null })
      .eq("id", r.id);
  }
  return { geradas };
}

const TIPO_DO_MARCO: Record<string, TipoDeAviso> = { no_dia: "prazo_hoje", atrasou: "prazo_atrasado" };

/** Avisa os marcos de prazo que chegaram (T8). Devolve quantos avisos saíram. */
export async function avisarPrazos(agora: Date = new Date()): Promise<{ avisados: number }> {
  const db = createAdminClient();
  if (!(await moduloLigado(db, "agencia"))) return { avisados: 0 };
  const [{ data: config }, { data: tarefas }] = await Promise.all([
    db.from("agencia_config").select("avisos_antecedencia").eq("id", true).maybeSingle(),
    db
      .from("agencia_tarefas")
      .select("id, titulo, prazo, agencia_clientes(nome), agencia_tarefas_responsaveis(membro_id), agencia_avisos_de_prazo(marco)")
      .is("concluida_em", null)
      .neq("coluna", "concluido")
      .not("prazo", "is", null)
      .lte("prazo", new Date(agora.getTime() + 8 * 86_400_000).toISOString()),
  ]);
  const antecedencia = ((config as { avisos_antecedencia?: number[] } | null)?.avisos_antecedencia ?? [2, 1]).filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= 7,
  );

  let avisados = 0;
  for (const t of (tarefas ?? []) as Array<{
    id: string;
    titulo: string;
    prazo: string;
    agencia_clientes: { nome: string } | Array<{ nome: string }> | null;
    agencia_tarefas_responsaveis: Array<{ membro_id: string }> | null;
    agencia_avisos_de_prazo: Array<{ marco: string }> | null;
  }>) {
    const marco = marcoDePrazo(new Date(t.prazo), antecedencia, agora);
    if (!marco) continue;
    if ((t.agencia_avisos_de_prazo ?? []).some((a) => a.marco === marco)) continue;
    const responsaveis = (t.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id);
    // Reserva o marco ANTES de avisar: se dois crons correrem juntos, só um passa.
    const { error } = await db.from("agencia_avisos_de_prazo").insert({ tarefa_id: t.id, marco });
    if (error) continue;
    if (responsaveis.length === 0) continue;
    const cliente = Array.isArray(t.agencia_clientes) ? t.agencia_clientes[0] : t.agencia_clientes;
    const dias = marco.startsWith("antes_") ? Number(marco.slice(6, -1)) : 0;
    const titulo =
      marco === "atrasou"
        ? `Atrasada: ${t.titulo}`
        : marco === "no_dia"
          ? `Vence hoje: ${t.titulo}`
          : `Vence em ${dias} dia${dias > 1 ? "s" : ""}: ${t.titulo}`;
    await criarAviso({
      alvo: { tipo: "membros", ids: responsaveis },
      tipo: TIPO_DO_MARCO[marco] ?? "prazo_chegando",
      titulo: cliente?.nome ? `${titulo} — ${cliente.nome}` : titulo,
      link: `/agencia/tarefas?abrir=${t.id}`,
      referenciaId: t.id,
    });
    avisados++;
  }
  return { avisados };
}
