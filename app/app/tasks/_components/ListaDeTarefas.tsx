"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  agrupaPorPrazo,
  estaAtrasada,
  estaEncerrada,
  type FaixaDePrazo,
  type PrioridadeDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";
import { Check, Kanban, PencilSimple, Trash, UserCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  tarefas: Tarefa[];
  podeEditar: boolean;
  aoAlternarConcluida: (tarefa: Tarefa) => Promise<unknown>;
  aoEditar: (tarefa: Tarefa) => void;
  aoApagar: (tarefa: Tarefa) => Promise<unknown>;
  /**
   * Mostrar de qual negócio é cada tarefa, com o atalho para ele. A tela de
   * Tarefas mostra; o dossiê não — lá dentro todas são do mesmo negócio, e
   * repetir o nome dele em cada linha só tomaria espaço.
   */
  mostrarNegocio?: boolean;
}

/** A cor é do TEMA, nunca um hex: ela tem de sobreviver ao claro e ao escuro. */
const COR_DA_PRIORIDADE: Record<PrioridadeDaTarefa, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-primary/10 text-primary",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-destructive/15 text-destructive",
};

function Linha({
  tarefa,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
  mostrarNegocio,
  nomeDoResponsavel,
}: {
  tarefa: Tarefa;
  podeEditar: boolean;
  aoAlternarConcluida: (t: Tarefa) => Promise<unknown>;
  aoEditar: (t: Tarefa) => void;
  aoApagar: (t: Tarefa) => Promise<unknown>;
  mostrarNegocio: boolean;
  /** Já resolvido por quem monta a lista; `null` = sem responsável conhecido. */
  nomeDoResponsavel: string | null;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [ocupada, setOcupada] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const encerrada = estaEncerrada(tarefa);
  const atrasada = estaAtrasada(tarefa);

  const rotuloDaPrioridade: Record<PrioridadeDaTarefa, string> = {
    low: t("Baixa"),
    medium: t("Média"),
    high: t("Alta"),
    urgent: t("Urgente"),
  };

  async function comBloqueio(acao: () => Promise<unknown>) {
    setOcupada(true);
    try {
      await acao();
    } finally {
      setOcupada(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40",
        encerrada && "opacity-60",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={encerrada}
        aria-label={encerrada ? t("Reabrir a tarefa") : t("Marcar como concluída")}
        disabled={ocupada || !podeEditar}
        onClick={() => comBloqueio(() => aoAlternarConcluida(tarefa))}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors",
          encerrada
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
      >
        {encerrada ? <Check size={12} weight="bold" aria-hidden /> : null}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            encerrada && "text-muted-foreground line-through",
          )}
        >
          {tarefa.title}
        </p>
        {tarefa.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{tarefa.description}</p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-medium",
              COR_DA_PRIORIDADE[tarefa.priority],
            )}
          >
            {rotuloDaPrioridade[tarefa.priority]}
          </span>
          <span className={cn("text-muted-foreground", atrasada && "font-semibold text-destructive")}>
            {tarefa.due_date
              ? new Date(tarefa.due_date).toLocaleString(tag, {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : t("Sem prazo")}
          </span>
          {nomeDoResponsavel ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <UserCircle size={12} aria-hidden />
              {nomeDoResponsavel}
            </span>
          ) : null}
          {mostrarNegocio && tarefa.lead ? (
            <Link
              href={`/app/leads/${tarefa.lead.id}`}
              className="flex min-w-0 max-w-[16rem] items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
              title={tarefa.lead.title}
            >
              <Kanban size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{tarefa.lead.title}</span>
            </Link>
          ) : null}
        </div>
      </div>

      {podeEditar ? (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("Editar a tarefa")}
            onClick={() => aoEditar(tarefa)}
          >
            <PencilSimple size={14} aria-hidden />
          </Button>
          {/*
            Confirmação em DOIS TOQUES no lugar de `confirm()`, que era o do
            original: `window.confirm` é bloqueado em iframe, ignora o tema e
            não passa por `t()` — o texto sai no idioma do navegador, não no da
            organização.
          */}
          {confirmando ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={ocupada}
              onClick={() => comBloqueio(() => aoApagar(tarefa))}
            >
              {t("Confirmar")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t("Apagar a tarefa")}
              onClick={() => setConfirmando(true)}
              onBlur={() => setConfirmando(false)}
            >
              <Trash size={14} aria-hidden />
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ListaDeTarefas({
  tarefas,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
  mostrarNegocio = true,
}: Props) {
  const t = useT();
  const usuario = useUser();
  const grupos = agrupaPorPrazo(tarefas);
  // Os nomes vêm da lista de responsáveis, que é `agent`+ na rota: para quem só
  // lê, a consulta nem sai e a linha fica sem o nome — nunca com um id cru.
  const membros = useAssignableMembers(podeEditar);
  const nomes = new Map((membros.data ?? []).map((m) => [m.user_id, m.full_name]));

  function nomeDoResponsavel(tarefa: Tarefa): string | null {
    if (!tarefa.assigned_to) return null;
    if (tarefa.assigned_to === usuario.id) return t("Eu");
    return nomes.get(tarefa.assigned_to) ?? null;
  }

  const rotuloDaFaixa: Record<FaixaDePrazo, string> = {
    atrasada: t("Atrasadas"),
    hoje: t("Hoje"),
    esta_semana: t("Esta semana"),
    mais_tarde: t("Mais tarde"),
    sem_prazo: t("Sem prazo"),
    encerrada: t("Encerradas"),
  };

  if (grupos.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-sm font-medium">{t("Nenhuma tarefa por aqui")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Enquanto isto estiver vazio, o que foi combinado vive só na memória de alguém.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grupos.map((grupo) => (
        <section key={grupo.faixa}>
          <h2
            className={cn(
              "mb-1 px-3 text-xs font-semibold uppercase tracking-wider",
              grupo.faixa === "atrasada" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {rotuloDaFaixa[grupo.faixa]}
          </h2>
          <div className="rounded-xl border bg-card py-1">
            {grupo.tarefas.map((tarefa) => (
              <Linha
                key={tarefa.id}
                tarefa={tarefa}
                podeEditar={podeEditar}
                aoAlternarConcluida={aoAlternarConcluida}
                aoEditar={aoEditar}
                aoApagar={aoApagar}
                mostrarNegocio={mostrarNegocio}
                nomeDoResponsavel={nomeDoResponsavel(tarefa)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
