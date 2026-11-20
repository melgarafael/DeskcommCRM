"use client";

import { useT } from "@/hooks/i18n/useT";
import { useTasks } from "@/hooks/tasks/useTasks";
import { tarefaEstaAberta } from "@/lib/tarefas/tipos";
import { cn } from "@/lib/utils";

/**
 * Quantas tarefas EM ABERTO são do usuário logado — o número ao lado de
 * "Tarefas" no menu.
 *
 * ─── Por que ele existe ─────────────────────────────────────────────────────
 *
 * Automação, follow-up e aviso de carteira criam tarefa para cada atendente. Sem
 * número no menu, a pessoa só descobria o que tinha para fazer abrindo a tela de
 * Tarefas por conta própria — e a tarefa atrasada passava o dia invisível. É o
 * mesmo problema que o contador de Casos resolveu no uso diário.
 *
 * ─── O que ele conta, e o que NÃO conta ─────────────────────────────────────
 *
 * Só as do PRÓPRIO usuário (`assigned_to: "me"`, que a rota resolve pela
 * sessão — nunca por um id vindo do navegador) e só as que pedem ação
 * (`pending` + `in_progress`, a régua de `SITUACOES_ABERTAS_DA_TAREFA`, a mesma
 * que `?aberto=true` aplica no servidor). `done` e `cancelled` não contam: são
 * trabalho encerrado. Gerente e administrador também veem só as suas aqui — a
 * visão da equipe é a tela, como antes.
 *
 * ─── Zero, erro e primeiro carregamento ─────────────────────────────────────
 *
 * Nada é desenhado nos três: número que nunca some ensina a ignorar o número
 * (a regra está escrita no catálogo, ao lado do campo `contador`). Em erro a
 * consulta devolve lista vazia e o contador simplesmente não aparece; quem
 * avisa sobre falha é a tela de Tarefas, que tem onde mostrar o motivo.
 *
 * `refetchInterval` de 60 s é o mesmo do contador de Casos: as tarefas nascem de
 * automação, sem gesto de ninguém nesta aba, então esperar o foco da janela
 * deixaria o número parado a manhã inteira.
 */
export function ContadorDeTarefas({ compacto }: { compacto: boolean }) {
  const t = useT();
  const { tarefas } = useTasks({ aberto: true, assigned_to: "me" }, { refetchInterval: 60_000 });
  const emAberto = tarefas.filter((tarefa) => tarefaEstaAberta(tarefa.status)).length;
  if (emAberto === 0) return null;
  const rotulo = emAberto === 1 ? t("1 tarefa em aberto") : `${emAberto} ${t("tarefas em aberto")}`;
  return (
    <span
      data-testid="contador-de-tarefas"
      aria-label={rotulo}
      title={rotulo}
      className={cn(
        "rounded-full bg-red-600 text-[10px] leading-none font-semibold text-white tabular-nums",
        compacto ? "absolute top-1 right-1 h-2 w-2" : "ml-auto px-1.5 py-0.5",
      )}
    >
      {compacto ? null : emAberto}
    </span>
  );
}
