import Link from "next/link";

import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { carregarQuemOlhaAgenda, listarReunioes } from "@/lib/agencia/calendario/consultas";
import { horaLocal, meiaNoite, somarDias } from "@/lib/agencia/calendario/regras";
import { diaLocal, estaAtrasada, formatarDataHora, formatarDuracao } from "@/lib/agencia/tarefas/regras";
import { carregarQuemOlha, listarTarefas } from "@/lib/agencia/tarefas/consultas";
import { ROTULO_DA_COLUNA } from "@/lib/agencia/tarefas/vocabulario";

export const metadata = { title: "Agência" };
export const dynamic = "force-dynamic";

/** Início da área: as reuniões de hoje, as minhas tarefas de hoje, as atrasadas e o cronômetro que estiver rodando. */
export default async function InicioDaAgencia() {
  const ctx = await requireAreaDaAgencia();
  const nome = (ctx.membro?.nome ?? (ctx.user.user_metadata?.full_name as string | undefined))?.split(" ")[0];
  const meu = ctx.membro?.id ?? null;
  const agora = new Date();
  const hoje = diaLocal(agora);

  const tarefas = meu ? (await listarTarefas(await carregarQuemOlha(ctx))).filter((t) => t.coluna !== "concluido") : [];
  const minhas = tarefas.filter((t) => meu && t.responsaveis.includes(meu));
  const rodando = minhas.find((t) => meu && t.rodandoPor.includes(meu));
  const atrasadas = minhas.filter((t) => estaAtrasada(t, agora));
  const deHoje = minhas.filter((t) => !estaAtrasada(t, agora) && (t.prazo ? diaLocal(new Date(t.prazo)) === hoje : t.coluna === "em_andamento"));
  const daFuncao = tarefas.filter((t) => t.podePegar);

  // Reuniões de hoje: as em que estou; quem não tem perfil de membro (o dono) vê as que alcança.
  const reunioesDoDia = (
    await listarReunioes(await carregarQuemOlhaAgenda(ctx), { de: meiaNoite(hoje), ate: meiaNoite(somarDias(hoje, 1)) })
  ).filter((r) => r.situacao !== "cancelada" && (!meu || r.membros.includes(meu)));

  const lista = (itens: typeof tarefas, vazio: string) =>
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
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{nome ? `Olá, ${nome}` : "Olá"}</h1>
        <p className="text-sm text-muted-foreground">O que está com você hoje.</p>
      </div>

      <section className="space-y-2" data-testid="reunioes-de-hoje">
        <h2 className="font-semibold">Reuniões de hoje ({reunioesDoDia.length})</h2>
        {reunioesDoDia.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma reunião hoje.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {reunioesDoDia.map((r) => (
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
        <p className="rounded-md border p-4 text-sm">
          Ative seu perfil em{" "}
          <Link href="/agencia/perfil" className="underline underline-offset-4">
            Perfil
          </Link>{" "}
          para receber tarefas e avisos como o resto da equipe.
        </p>
      ) : (
        <>
          {rodando && (
            <Link href={`/agencia/tarefas?abrir=${rodando.id}`} className="block rounded-md border border-emerald-500/50 bg-emerald-500/10 p-4 text-sm">
              Cronômetro rodando em <strong>{rodando.titulo}</strong> · {formatarDuracao(rodando.tempoSegundos)}
            </Link>
          )}
          <section className="space-y-2">
            <h2 className="font-semibold text-destructive">Atrasadas ({atrasadas.length})</h2>
            {lista(atrasadas, "Nenhuma tarefa atrasada.")}
          </section>
          <section className="space-y-2">
            <h2 className="font-semibold">Para hoje ({deHoje.length})</h2>
            {lista(deHoje, "Nada vence hoje.")}
          </section>
          {daFuncao.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-semibold">Da sua função, sem dono ({daFuncao.length})</h2>
              {lista(daFuncao, "")}
            </section>
          )}
          <Link href="/agencia/tarefas" className="inline-block text-sm underline underline-offset-4">
            Ver todas as tarefas
          </Link>
        </>
      )}
    </div>
  );
}
