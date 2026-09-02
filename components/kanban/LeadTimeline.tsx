"use client";
import { useState } from "react";

import { cn } from "@/lib/utils";
import {
  activityLabel,
  actorLabel,
  actorName,
  actorShape,
} from "@/lib/leads/activity-vocabulary";
import { agrupaTimeline, ehBlocoColapsavel, ehBlocoDeDia } from "@/lib/leads/timeline-grouping";
import type { TimelineItemView } from "@/lib/types/contacts";

interface Props {
  itens: TimelineItemView[];
  /** Ids que chegaram por realtime nesta sessão — ficam FORA do agrupamento. */
  chegouAoVivo: Set<string>;
  isLoading: boolean;
  isError: boolean;
}

function quando(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-PT", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** O marcador do ator: FORMA, nunca cor — a cor é da borda de estado (Lei C). */
function Marcador({ item }: { item: TimelineItemView }) {
  const forma = actorShape(item.actor_kind ?? null);
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 h-2 w-2 shrink-0 rounded-full",
        forma === "filled" && "bg-text",
        forma === "ring" && "border border-text bg-transparent",
        forma === "dashed" && "border border-dashed border-text-muted bg-transparent",
      )}
    />
  );
}

function Linha({ item, aoVivo }: { item: TimelineItemView; aoVivo?: boolean }) {
  const nome = actorName(item.actor_kind ?? null, {
    agente: item.actor_agent_name ?? null,
    usuario: item.actor_user_name ?? null,
  });
  return (
    <li className="flex gap-2 py-1.5">
      <Marcador item={item} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text">
          {activityLabel(item.type)}
          {aoVivo && (
            // O que chegou AGORA fica marcado: sem isto ele entraria na lista
            // idêntico ao resto e a chegada seria indistinguível do histórico.
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-accent">
              agora
            </span>
          )}
        </p>
        {item.reason && <p className="mt-0.5 text-xs text-text-muted">{item.reason}</p>}
        <p className="mt-0.5 text-[11px] text-text-muted">
          {nome} · {quando(item.performed_at)}
        </p>
      </div>
    </li>
  );
}

/**
 * A timeline do dossiê — linha vertical, marcador por ator, blocos expansíveis.
 *
 * O agrupamento vem de `agrupaTimeline`, que é função pura e testada: decisão
 * humana nunca colapsa, e o que chegou ao vivo nesta sessão fica fora do bloco.
 * Reimplementar a regra aqui dentro seria a mesma falha que o card já pagou —
 * precedência reescrita em componente é rejeição de review.
 */
export function LeadTimeline({ itens, chegouAoVivo, isLoading, isError }: Props) {
  const [abertos, setAbertos] = useState<Set<number>>(new Set());
  const blocos = agrupaTimeline(itens, chegouAoVivo);

  if (isLoading) {
    return <p className="py-4 text-xs text-text-muted">Carregando a linha do tempo…</p>;
  }
  // TRÊS estados, não dois: "não consegui ler" é diferente de "não há nada".
  // Transformar erro em lista vazia diria ao usuário que o lead não tem
  // história, quando o que houve foi uma falha de leitura.
  if (isError) {
    return (
      <p className="py-4 text-xs text-warning-fg">
        Não consegui carregar a linha do tempo. Tente de novo em instantes.
      </p>
    );
  }
  if (itens.length === 0) {
    return <p className="py-4 text-xs text-text-muted">Nada aconteceu com este negócio ainda.</p>;
  }

  return (
    <ul className="border-l border-border pl-3">
      {blocos.map((b, i) => {
        if (b.tipo === "item") {
          return <Linha key={b.item.id} item={b.item} aoVivo={b.aoVivo} />;
        }
        if (b.tipo === "dia") {
          // Bloco de dia com UM item só não vira bloco: "terça · 1 ação" custa
          // um clique e não informa nada que a própria linha não informe.
          if (!ehBlocoDeDia(b)) return <Linha key={b.itens[0]!.id} item={b.itens[0]!} />;
          const aberto = abertos.has(i);
          return (
            <li key={b.dia} className="py-1.5">
              <button
                type="button"
                onClick={() =>
                  setAbertos((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
                aria-expanded={aberto}
                className="flex w-full items-center gap-2 text-left text-xs text-text-muted hover:text-text"
              >
                {/* O marcador do dia é uma BARRA, não um ponto: ele não
                    representa um ator, e reusar a forma de ator diria que
                    alguém fez aquilo. */}
                <span aria-hidden className="mt-1 h-2 w-0.5 shrink-0 bg-border" />
                <span className="first-letter:uppercase">{b.rotulo}</span>
                <span className="text-text-muted">· {b.itens.length} ações</span>
                <span aria-hidden className="ml-auto text-[10px]">
                  {aberto ? "−" : "+"}
                </span>
              </button>
              {aberto && (
                <ul className="ml-2 border-l border-border pl-3">
                  {b.itens.map((it) => (
                    <Linha key={it.id} item={it} />
                  ))}
                </ul>
              )}
            </li>
          );
        }
        if (!ehBlocoColapsavel(b)) {
          return <Linha key={b.itens[0]!.id} item={b.itens[0]!} />;
        }
        const aberto = abertos.has(i);
        const primeiro = b.itens[0]!;
        const nome = actorName(primeiro.actor_kind ?? null, {
          agente: primeiro.actor_agent_name ?? null,
          usuario: primeiro.actor_user_name ?? null,
        });
        return (
          <li key={`g${i}`} className="py-1.5">
            <button
              type="button"
              onClick={() =>
                setAbertos((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              aria-expanded={aberto}
              className="flex w-full items-center gap-2 text-left text-xs text-text-muted hover:text-text"
            >
              <Marcador item={primeiro} />
              <span>
                {nome} · {b.itens.length} ações
              </span>
              <span aria-hidden className="ml-auto text-[10px]">
                {aberto ? "−" : "+"}
              </span>
            </button>
            {aberto && (
              <ul className="ml-2 border-l border-border pl-3">
                {b.itens.map((it) => (
                  <Linha key={it.id} item={it} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
