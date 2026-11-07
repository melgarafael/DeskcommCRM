"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { CaretDown } from "@/lib/ui/icons";

/**
 * Acordeão de LISTA — um item aberto por vez.
 *
 * Por que um componente, e não o padrão copiado em cada tela: listas que crescem
 * (aprendizados da memória, etapas do funil) sofrem do mesmo mal — cada linha
 * aberta mostra corpo e ações, e a página de 10+ vira uma parede em que nada se
 * acha. A #4083 pede a MESMA recolha para as etapas do funil; ter um lugar só
 * evita duas cópias divergindo no `aria-expanded` e no toggle.
 *
 * Por que sem biblioteca: o que a tela precisa é de estado de "qual está
 * aberto" — `Radix Accordion` inteiro para isso seria dependência nova por
 * comportamento que cabe em vinte linhas (a regra do repositório é não somar
 * UI nova sem necessidade).
 *
 * Controlado de propósito (`value`/`onValueChange`, como o `Tabs`): quem usa
 * decide se a linha recém-criada abre, e o estado sobrevive a re-render de
 * formulário no mesmo cartão. `null` = tudo fechado.
 *
 * Acessível: o cabeçalho é um `button` de verdade (teclado e leitor de tela de
 * graça), `aria-expanded` diz o estado, `aria-controls` aponta para o `id` do
 * painel e o painel é `region` rotulada pelo botão. O painel só existe no DOM
 * quando aberto — mesmo comportamento do Radix e o que faz o conteúdo fechado
 * não ser tabulável.
 */
interface ContextoDoAcordeao {
  aberto: string | null;
  alternar: (valor: string) => void;
}

const Ctx = React.createContext<ContextoDoAcordeao | null>(null);

function useAcordeao(): ContextoDoAcordeao {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error("<AccordionItem> precisa estar dentro de <Accordion>");
  return ctx;
}

export function Accordion({
  value,
  onValueChange,
  className,
  children,
}: {
  /** O `value` do item aberto, ou `null` com todos fechados. */
  value: string | null;
  onValueChange: (valor: string | null) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const alternar = React.useCallback(
    (valor: string) => onValueChange(value === valor ? null : valor),
    [onValueChange, value],
  );
  const contexto = React.useMemo(() => ({ aberto: value, alternar }), [alternar, value]);
  return (
    <Ctx.Provider value={contexto}>
      <ul className={cn("flex flex-col gap-2", className)}>{children}</ul>
    </Ctx.Provider>
  );
}

export function AccordionItem({
  value,
  summary,
  children,
  className,
  contentClassName,
}: {
  /** Identidade do item dentro do `Accordion` — o id da linha, não o índice. */
  value: string;
  /** O que fica sempre visível no cabeçalho: título, selos, data. */
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const { aberto, alternar } = useAcordeao();
  // `useId` e não `${value}`: o id do DOM não pode colidir com outro acordeão
  // na mesma página nem depender de o id de negócio ser válido em HTML.
  const idDoBotao = React.useId();
  const idDoPainel = React.useId();
  const expandido = aberto === value;

  return (
    <li className={cn("rounded-md border border-border/60 text-sm", className)}>
      <button
        type="button"
        id={idDoBotao}
        aria-expanded={expandido}
        aria-controls={idDoPainel}
        onClick={() => alternar(value)}
        className="flex w-full items-start gap-2 rounded-md p-3 text-left hover:bg-accent-soft focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{summary}</span>
        <CaretDown
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            expandido && "rotate-180",
          )}
        />
      </button>
      {expandido ? (
        <div
          id={idDoPainel}
          role="region"
          aria-labelledby={idDoBotao}
          className={cn("flex flex-col gap-2 border-t border-border/60 p-3", contentClassName)}
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}
