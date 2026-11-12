import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { ContextoDaAgencia } from "../acesso";
import { carregarAlcance } from "../clientes/visibilidade";

/**
 * Consultas agregadas para o dashboard da agência (Início).
 * Tudo roda no servidor; usa admin client filtrado pelo alcance do usuário.
 */

const db = createAdminClient();

function mesAtual(): { inicio: string; fim: string } {
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const fim = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

function semanaAtual(): { inicio: string; fim: string } {
  const agora = new Date();
  const inicio = new Date(agora);
  inicio.setDate(agora.getDate() - agora.getDay()); // domingo
  inicio.setHours(0, 0, 0, 0);
  const fim = new Date(inicio);
  fim.setDate(inicio.getDate() + 6);
  fim.setHours(23, 59, 59, 999);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

/** ---------- Clientes ---------- */

export interface KpiClientes {
  total: number;
  ativos: number;
  semEquipe: number;
  porSituacao: Record<string, number>;
}

export async function kpiClientes(ctx: ContextoDaAgencia): Promise<KpiClientes> {
  const alcance = await carregarAlcance(ctx);
  let q = db.from("agencia_clientes").select("id, situacao", { count: "exact" });
  if (!alcance.todos) q = q.in("id", [...alcance.ids]);
  const { data, count } = await q;

  const clientes = (data ?? []) as Array<{ id: string; situacao: string }>;
  const porSituacao: Record<string, number> = {};
  for (const c of clientes) porSituacao[c.situacao] = (porSituacao[c.situacao] ?? 0) + 1;

  // Clientes sem equipe (apenas os que o usuário alcança)
  let semEquipe = 0;
  if (clientes.length > 0) {
    const ids = clientes.map((c) => c.id);
    const { data: membros } = await db
      .from("agencia_clientes_membros")
      .select("cliente_id")
      .in("cliente_id", ids);
    const comEquipe = new Set((membros ?? []).map((m) => m.cliente_id));
    semEquipe = clientes.filter((c) => !comEquipe.has(c.id)).length;
  }

  return {
    total: count ?? 0,
    ativos: porSituacao.ativo ?? 0,
    semEquipe,
    porSituacao,
  };
}

/** ---------- Publicações ---------- */

export interface KpiPublicacoes {
  agendadasSemana: number;
  aprovadasSemana: number;
  publicadasSemana: number;
  publicadasMes: number;
  falharamSemana: number;
  porSituacao: Record<string, number>;
}

export async function kpiPublicacoes(ctx: ContextoDaAgencia): Promise<KpiPublicacoes> {
  const alcance = await carregarAlcance(ctx);
  const { inicio: iniSemana, fim: fimSemana } = semanaAtual();
  const { inicio: iniMes, fim: fimMes } = mesAtual();

  let base = db.from("agencia_publicacoes").select("id, situacao, quando, cliente_id");
  if (!alcance.todos) base = base.in("cliente_id", [...alcance.ids]);

  const [{ data: semana }, { data: mes }, { data: todas }] = await Promise.all([
    base.gte("quando", iniSemana).lte("quando", fimSemana),
    base.gte("quando", iniMes).lte("quando", fimMes),
    base, // todas para contagem por situação
  ]);

  const pubSemana = (semana ?? []) as Array<{ situacao: string }>;
  const pubMes = (mes ?? []) as Array<{ situacao: string }>;
  const pubTodas = (todas ?? []) as Array<{ situacao: string }>;

  const porSituacao: Record<string, number> = {};
  for (const p of pubTodas) porSituacao[p.situacao] = (porSituacao[p.situacao] ?? 0) + 1;

  return {
    agendadasSemana: pubSemana.filter((p) => p.situacao === "agendada").length,
    aprovadasSemana: pubSemana.filter((p) => p.situacao === "aprovada").length,
    publicadasSemana: pubSemana.filter((p) => p.situacao === "publicada").length,
    publicadasMes: pubMes.filter((p) => p.situacao === "publicada").length,
    falharamSemana: pubSemana.filter((p) => p.situacao === "falhou").length,
    porSituacao,
  };
}

/** Série diária de publicações publicadas (últimos 30 dias) para gráfico de linha. */
export interface SeriePublicacoesDiaria {
  dia: string; // "AAAA-MM-DD"
  publicadas: number;
  falharam: number;
}

export async function seriePublicacoesDiaria(ctx: ContextoDaAgencia, dias = 30): Promise<SeriePublicacoesDiaria[]> {
  const alcance = await carregarAlcance(ctx);
  const ate = new Date();
  const de = new Date();
  de.setDate(de.getDate() - dias + 1);
  de.setHours(0, 0, 0, 0);

  let q = db
    .from("agencia_publicacoes")
    .select("situacao, publicada_em")
    .eq("situacao", "publicada")
    .gte("publicada_em", de.toISOString())
    .lte("publicada_em", ate.toISOString());
  if (!alcance.todos) q = q.in("cliente_id", [...alcance.ids]);
  const { data: pubs } = await q;

  const pubPorDia = new Map<string, number>();
  for (const p of (pubs ?? []) as Array<{ publicada_em: string }>) {
    const dia = p.publicada_em.slice(0, 10);
    pubPorDia.set(dia, (pubPorDia.get(dia) ?? 0) + 1);
  }

  // Falharam
  let qf = db
    .from("agencia_publicacoes")
    .select("situacao, atualizado_em")
    .eq("situacao", "falhou")
    .gte("atualizado_em", de.toISOString())
    .lte("atualizado_em", ate.toISOString());
  if (!alcance.todos) qf = qf.in("cliente_id", [...alcance.ids]);
  const { data: falhas } = await qf;

  const falhasPorDia = new Map<string, number>();
  for (const f of (falhas ?? []) as Array<{ atualizado_em: string }>) {
    const dia = f.atualizado_em.slice(0, 10);
    falhasPorDia.set(dia, (falhasPorDia.get(dia) ?? 0) + 1);
  }

  const out: SeriePublicacoesDiaria[] = [];
  const cursor = new Date(de);
  while (cursor <= ate) {
    const dia = cursor.toISOString().slice(0, 10);
    out.push({
      dia,
      publicadas: pubPorDia.get(dia) ?? 0,
      falharam: falhasPorDia.get(dia) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** ---------- Contratos ---------- */

export interface KpiContratos {
  aguardando: number; // aguardando assinatura/pagamento
  vencidos: number;
  concluidosMes: number;
  porSituacao: Record<string, number>;
}

export async function kpiContratos(ctx: ContextoDaAgencia): Promise<KpiContratos> {
  const alcance = await carregarAlcance(ctx);
  const hoje = new Date().toISOString().slice(0, 10);
  const { inicio: iniMes } = mesAtual();

  let base = db.from("agencia_contratos").select("id, situacao, assinado_em, pago_em, valido_ate, concluido_em, cliente_id");
  if (!alcance.todos) base = base.in("cliente_id", [...alcance.ids]);

  const { data } = await base;
  const contratos = (data ?? []) as Array<{
    situacao: string;
    assinado_em: string | null;
    pago_em: string | null;
    valido_ate: string;
    concluido_em: string | null;
  }>;

  const porSituacao: Record<string, number> = {};
  let aguardando = 0;
  let vencidos = 0;
  let concluidosMes = 0;

  for (const c of contratos) {
    const sit = c.situacao;
    porSituacao[sit] = (porSituacao[sit] ?? 0) + 1;

    if (sit === "aguardando") aguardando++;
    if (sit === "aguardando" && c.valido_ate < hoje) vencidos++;
    if (sit === "concluido" && c.concluido_em && c.concluido_em >= iniMes) concluidosMes++;
  }

  return { aguardando, vencidos, concluidosMes, porSituacao };
}

/** Distribuição de situações de contratos para gráfico de pizza. */
export interface FatiaContrato {
  situacao: string;
  quantidade: number;
  label: string;
}

export async function distribuicaoContratos(ctx: ContextoDaAgencia): Promise<FatiaContrato[]> {
  const { porSituacao } = await kpiContratos(ctx);
  const ROTULOS: Record<string, string> = {
    rascunho: "Rascunho",
    aguardando: "Aguardando",
    assinado: "Assinado",
    pago: "Pago",
    concluido: "Concluído",
    vencido: "Vencido",
    recusado: "Recusado",
    cancelado: "Cancelado",
  };
  return Object.entries(porSituacao)
    .map(([situacao, quantidade]) => ({ situacao, quantidade, label: ROTULOS[situacao] ?? situacao }))
    .sort((a, b) => b.quantidade - a.quantidade);
}

/** ---------- Tarefas ---------- */

export interface KpiTarefas {
  abertas: number;
  atrasadas: number;
  concluidasSemana: number;
  porColuna: Record<string, number>;
}

export async function kpiTarefas(ctx: ContextoDaAgencia): Promise<KpiTarefas> {
  const { carregarQuemOlha, listarTarefasParaDashboard } = await import("../tarefas/consultas");
  const quem = await carregarQuemOlha(ctx);
  const tarefas = await listarTarefasParaDashboard(quem);
  const agora = new Date();

  const porColuna: Record<string, number> = {};
  let abertas = 0;
  let atrasadas = 0;
  let concluidasSemana = 0;
  const umaSemanaAtras = new Date(agora.getTime() - 7 * 86_400_000);

  for (const t of tarefas) {
    porColuna[t.coluna] = (porColuna[t.coluna] ?? 0) + 1;
    if (t.coluna !== "concluido") abertas++;
    if (t.prazo && new Date(t.prazo) < agora && t.coluna !== "concluido") atrasadas++;
    if (t.coluna === "concluido" && t.concluidaEm && new Date(t.concluidaEm) >= umaSemanaAtras) concluidasSemana++;
  }

  return { abertas, atrasadas, concluidasSemana, porColuna };
}

/** Tarefas concluídas por dia (últimos 14 dias) para gráfico de barras. */
export interface SerieTarefasDiaria {
  dia: string;
  concluidas: number;
}

export async function serieTarefasDiaria(ctx: ContextoDaAgencia, dias = 14): Promise<SerieTarefasDiaria[]> {
  const { carregarQuemOlha, listarTarefasConcluidasRecentes } = await import("../tarefas/consultas");
  const quem = await carregarQuemOlha(ctx);
  const tarefas = await listarTarefasConcluidasRecentes(quem, dias);

  const porDia = new Map<string, number>();
  for (const t of tarefas) {
    if (t.concluidaEm) {
      const dia = t.concluidaEm.slice(0, 10);
      porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
    }
  }

  const out: SerieTarefasDiaria[] = [];
  const ate = new Date();
  const de = new Date();
  de.setDate(de.getDate() - dias + 1);
  de.setHours(0, 0, 0, 0);
  const cursor = new Date(de);
  while (cursor <= ate) {
    const dia = cursor.toISOString().slice(0, 10);
    out.push({ dia, concluidas: porDia.get(dia) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** ---------- Alertas ---------- */

export interface AlertaDashboard {
  tipo: "contrato_vencido" | "publicacao_falhou" | "tarefa_atrasada" | "cliente_sem_equipe";
  prioridade: "critica" | "atencao" | "info";
  titulo: string;
  descricao: string;
  link: string;
  contador: number;
}

export async function alertasDashboard(ctx: ContextoDaAgencia): Promise<AlertaDashboard[]> {
  const alcance = await carregarAlcance(ctx);
  const hoje = new Date().toISOString().slice(0, 10);
  const alertas: AlertaDashboard[] = [];

  // 1. Contratos vencidos (proposta vencida sem assinar/pagar)
  if (ctx.permissoes.has("contratos.gerenciar") || ctx.ehDono) {
    let q = db.from("agencia_contratos").select("id, cliente_id, valido_ate", { count: "exact" })
      .eq("situacao", "aguardando")
      .lt("valido_ate", hoje);
    if (!alcance.todos) q = q.in("cliente_id", [...alcance.ids]);
    const { count } = await q;
    if ((count ?? 0) > 0) {
      alertas.push({
        tipo: "contrato_vencido",
        prioridade: "critica",
        titulo: "Propostas vencidas",
        descricao: `${count} proposta(s) passaram da validade sem assinatura e pagamento.`,
        link: "/agencia/contratos?filtro=vencidos",
        contador: count ?? 0,
      });
    }
  }

  // 2. Publicações que falharam esta semana
  const { inicio: iniSemana } = semanaAtual();
  let qFalhou = db.from("agencia_publicacoes").select("id, cliente_id, titulo", { count: "exact" })
    .eq("situacao", "falhou")
    .gte("atualizado_em", iniSemana);
  if (!alcance.todos) qFalhou = qFalhou.in("cliente_id", [...alcance.ids]);
  const { count: falharam } = await qFalhou;
  if ((falharam ?? 0) > 0) {
    alertas.push({
      tipo: "publicacao_falhou",
      prioridade: "atencao",
      titulo: "Publicações que falharam",
      descricao: `${falharam} publicação(ões) programadas não foram publicadas esta semana.`,
      link: "/agencia/publicacoes?filtro=falhou",
      contador: falharam ?? 0,
    });
  }

  // 3. Tarefas muito atrasadas (> 7 dias) — só se tem permissão ver_todas
  if (ctx.permissoes.has("tarefas.ver_todas") || ctx.ehDono) {
    const seteDiasAtras = new Date(Date.now() - 7 * 86_400_000).toISOString();
    let qAtras = db.from("agencia_tarefas").select("id, cliente_id", { count: "exact" })
      .neq("coluna", "concluido")
      .lt("prazo", seteDiasAtras);
    if (!alcance.todos) qAtras = qAtras.in("cliente_id", [...alcance.ids]);
    const { count: mtAtras } = await qAtras;
    if ((mtAtras ?? 0) > 0) {
      alertas.push({
        tipo: "tarefa_atrasada",
        prioridade: "atencao",
        titulo: "Tarefas muito atrasadas",
        descricao: `${mtAtras} tarefa(s) estão atrasadas há mais de 7 dias.`,
        link: "/agencia/tarefas?filtro=muito-atrasadas",
        contador: mtAtras ?? 0,
      });
    }
  }

  // 4. Clientes ativos sem equipe
  if (ctx.permissoes.has("clientes.gerenciar") || ctx.ehDono) {
    let qAtivos = db.from("agencia_clientes").select("id").eq("situacao", "ativo");
    if (!alcance.todos) qAtivos = qAtivos.in("id", [...alcance.ids]);
    const { data: ativos } = await qAtivos;
    if (ativos && ativos.length > 0) {
      const ids = ativos.map((a) => a.id);
      const { data: comEquipe } = await db
        .from("agencia_clientes_membros")
        .select("cliente_id")
        .in("cliente_id", ids);
      const setEquipe = new Set((comEquipe ?? []).map((m) => m.cliente_id));
      const semEquipe = ativos.filter((a) => !setEquipe.has(a.id)).length;
      if (semEquipe > 0) {
        alertas.push({
          tipo: "cliente_sem_equipe",
          prioridade: "info",
          titulo: "Clientes ativos sem equipe",
          descricao: `${semEquipe} cliente(s) ativo(s) não têm ninguém da equipe atribuído.`,
          link: "/agencia/clientes?filtro=sem-equipe",
          contador: semEquipe,
        });
      }
    }
  }

  return alertas;
}