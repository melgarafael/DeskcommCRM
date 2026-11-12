import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarQuemOlhaAgenda, listarReunioes } from "@/lib/agencia/calendario/consultas";
import { horaLocal, meiaNoite, somarDias } from "@/lib/agencia/calendario/regras";
import { diaLocal, estaAtrasada, formatarDataHora, formatarDuracao } from "@/lib/agencia/tarefas/regras";
import { listarTarefas, carregarQuemOlha } from "@/lib/agencia/tarefas/consultas";
import { ROTULO_DA_COLUNA } from "@/lib/agencia/tarefas/vocabulario";

import {
  kpiClientes,
  kpiPublicacoes,
  kpiContratos,
  kpiTarefas,
  seriePublicacoesDiaria,
  serieTarefasDiaria,
  distribuicaoContratos,
  alertasDashboard,
} from "@/lib/agencia/dashboard/consultas";

import Link from "next/link";
import {
  KpiGrid,
  KpiCard,
  Secao,
  AlertaItem,
} from "@/components/agencia/DashboardUI";
import {
  PublicacoesLinha,
  TarefasBarras,
  ContratosPizza,
  TarefasPorColuna,
} from "@/components/agencia/DashboardCharts";
import { Users, FileText, Megaphone, CheckCircle, WarningOctagon, Clock, ChartLineUp, Buildings } from "@/lib/ui/icons";

export const metadata = { title: "Agência" };
export const dynamic = "force-dynamic";

/** Início da área: dashboard completo com KPIs, alertas, gráficos + reuniões e tarefas do usuário. */
export default async function InicioDaAgencia() {
  const ctx = await requireAreaDaAgencia();
  const nome = (ctx.membro?.nome ?? (ctx.user.user_metadata?.full_name as string | undefined))?.split(" ")[0];
  const meu = ctx.membro?.id ?? null;
  const agora = new Date();
  const hoje = diaLocal(agora);

  // Buscar todos os dados em paralelo
  const [
    clientes,
    publicacoes,
    contratos,
    tarefasKpi,
    pubSerie,
    tarefasSerie,
    contratosDist,
    alertas,
    tarefasUsuario,
    reunioesDoDia,
  ] = await Promise.all([
    kpiClientes(ctx),
    kpiPublicacoes(ctx),
    kpiContratos(ctx),
    kpiTarefas(ctx),
    seriePublicacoesDiaria(ctx, 30),
    serieTarefasDiaria(ctx, 14),
    distribuicaoContratos(ctx),
    alertasDashboard(ctx),
    meu ? listarTarefas(await carregarQuemOlha(ctx)) : Promise.resolve([]),
    listarReunioes(await carregarQuemOlhaAgenda(ctx), {
      de: meiaNoite(hoje),
      ate: meiaNoite(somarDias(hoje, 1)),
    }),
  ]);

  const minhas = tarefasUsuario.filter((t) => meu && t.responsaveis.includes(meu));
  const rodando = minhas.find((t) => meu && t.rodandoPor.includes(meu));
  const atrasadas = minhas.filter((t) => estaAtrasada(t, agora));
  const deHoje = minhas.filter(
    (t) => !estaAtrasada(t, agora) && (t.prazo ? diaLocal(new Date(t.prazo)) === hoje : t.coluna === "em_andamento")
  );
  const daFuncao = tarefasUsuario.filter((t) => t.podePegar);

  const reunioesFiltradas = reunioesDoDia.filter(
    (r: typeof reunioesDoDia[0]) => r.situacao !== "cancelada" && (!meu || r.membros.includes(meu))
  );

  const lista = (itens: typeof minhas, vazio: string) =>
    itens.length === 0 ? (
      <p className="text-sm text-muted-foreground">{vazio}</p>
    ) : (
      <ul className="divide-y rounded-md border">
        {itens.map((t) => (
          <li key={t.id}>
            <Link href={`/agencia/tarefas?abrir=${t.id}`} className="flex items-center justify-between gap-3 p-3 text-sm hover:bg-accent/40">
              <span className="min-w-0">
                <span className="block truncate font-medium">{t.titulo}</span>
                <span className="text-xs text-muted-foreground">
                  {[t.clienteNome, ROTULO_DA_COLUNA[t.coluna]].filter(Boolean).join(" · ")}
                </span>
              </span>
              {t.prazo && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatarDataHora(t.prazo)}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 sm:px-6">
      {/* Cabeçalho */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{nome ? `Olá, ${nome}` : "Olá"}</h1>
        <p className="text-sm text-muted-foreground">Visão geral da agência — {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>

      {/* ALERTAS — sempre no topo se houver */}
      {alertas.length > 0 && (
        <Secao titulo="⚠ Precisam de atenção" linkMais={{ href: "/agencia/alertas", label: "Ver todos" }}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {alertas.map((a) => (
              <AlertaItem
                key={a.tipo}
                tipo={a.prioridade}
                titulo={a.titulo}
                descricao={a.descricao}
                contador={a.contador}
                link={a.link}
                icone={
                  a.tipo === "contrato_vencido" ? <FileText size={16} /> :
                  a.tipo === "publicacao_falhou" ? <Megaphone size={16} /> :
                  a.tipo === "tarefa_atrasada" ? <Clock size={16} /> :
                  <Users size={16} />
                }
              />
            ))}
          </div>
        </Secao>
      )}

      {/* KPIs GERAIS */}
      <Secao titulo="Indicadores gerais">
        <KpiGrid>
          <KpiCard
            label="Clientes ativos"
            value={clientes.ativos}
            delta={{ valor: clientes.total - clientes.ativos, label: "de " + clientes.total + " total", positivo: false }}
            icone={<Buildings size={18} />}
          />
          <KpiCard
            label="Sem equipe atribuída"
            value={clientes.semEquipe}
            delta={{ valor: clientes.semEquipe, label: "precisam de dono", positivo: false }}
            icone={<Users size={18} />}
          />
          <KpiCard
            label="Publicadas esta semana"
            value={publicacoes.publicadasSemana}
            delta={{ valor: publicacoes.aprovadasSemana - publicacoes.publicadasSemana, label: "aprovadas: " + publicacoes.aprovadasSemana, positivo: publicacoes.aprovadasSemana >= publicacoes.publicadasSemana }}
            tendencia={pubSerie.slice(-12).map((d) => d.publicadas)}
            icone={<Megaphone size={18} />}
          />
          <KpiCard
            label="Falharam esta semana"
            value={publicacoes.falharamSemana}
            delta={{ valor: publicacoes.falharamSemana, label: "precisam revisão", positivo: false }}
            icone={<WarningOctagon size={18} />}
          />
          <KpiCard
            label="Aguardando assinatura/pagamento"
            value={contratos.aguardando}
            delta={{ valor: contratos.vencidos, label: contratos.vencidos + " vencidas", positivo: false }}
            icone={<FileText size={18} />}
          />
          <KpiCard
            label="Concluídos este mês"
            value={contratos.concluidosMes}
            icone={<CheckCircle size={18} />}
          />
          <KpiCard
            label="Tarefas abertas"
            value={tarefasKpi.abertas}
            delta={{ valor: tarefasKpi.atrasadas, label: tarefasKpi.atrasadas + " atrasadas", positivo: false }}
            tendencia={tarefasSerie.slice(-12).map((d) => d.concluidas)}
            icone={<ChartLineUp size={18} />}
          />
          <KpiCard
            label="Concluídas na semana"
            value={tarefasKpi.concluidasSemana}
            icone={<CheckCircle size={18} />}
          />
        </KpiGrid>
      </Secao>

      {/* GRÁFICOS — linha + barras + pizza */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PublicacoesLinha dados={pubSerie} />
        <TarefasBarras dados={tarefasSerie} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ContratosPizza dados={contratosDist} />
        <TarefasPorColuna dados={tarefasKpi.porColuna} />
      </div>

      {/* REUNIÕES DE HOJE + TAREFAS DO USUÁRIO (mantido do original) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2" data-testid="reunioes-de-hoje">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Reuniões de hoje ({reunioesFiltradas.length})</h2>
            <Link href="/agencia/calendario" className="text-sm underline underline-offset-2 hover:text-foreground">
              Ver calendário
            </Link>
          </div>
          {reunioesFiltradas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma reunião hoje.</p>
          ) : (
            <ul className="divide-y rounded-md border max-h-80 overflow-y-auto">
              {reunioesFiltradas.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <Link href={`/agencia/calendario?abrir=${r.id}`} className="min-w-0 hover:underline">
                    <span className="block truncate font-medium">{r.titulo}</span>
                    <span className="text-xs text-muted-foreground">
                      {horaLocal(r.inicio)}–{horaLocal(r.fim)}
                    </span>
                  </Link>
                  {r.meetUrl && (
                    <a href={r.meetUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border px-2 py-1 text-xs font-medium">
                      Entrar no Meet
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {!meu ? (
          <section className="space-y-2">
            <div className="rounded-md border p-4 text-sm">
              Ative seu perfil em{" "}
              <Link href="/agencia/perfil" className="underline underline-offset-4">
                Perfil
              </Link>{" "}
              para receber tarefas e avisos como o resto da equipe.
            </div>
          </section>
        ) : (
          <section className="space-y-2 lg:col-span-2">
            {rodando && (
              <Link href={`/agencia/tarefas?abrir=${rodando.id}`} className="block rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4 text-sm mb-4">
                Cronômetro rodando em <strong>{rodando.titulo}</strong> · {formatarDuracao(rodando.tempoSegundos)}
              </Link>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <h2 className="font-semibold text-destructive mb-2">Atrasadas ({atrasadas.length})</h2>
                {lista(atrasadas, "Nenhuma tarefa atrasada.")}
              </div>
              <div>
                <h2 className="font-semibold mb-2">Para hoje ({deHoje.length})</h2>
                {lista(deHoje, "Nada vence hoje.")}
              </div>
              {daFuncao.length > 0 && (
                <div>
                  <h2 className="font-semibold mb-2">Da sua função, sem dono ({daFuncao.length})</h2>
                  {lista(daFuncao, "")}
                </div>
              )}
            </div>
            <Link href="/agencia/tarefas" className="inline-block text-sm underline underline-offset-4 mt-2">
              Ver todas as tarefas
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}