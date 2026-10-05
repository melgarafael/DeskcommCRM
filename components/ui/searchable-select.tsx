"use client";

import * as React from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, Check, MagnifyingGlass } from "@/lib/ui/icons";
import { filtrarOpcoes, type OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
import { cn } from "@/lib/utils";

/**
 * A partir de quantas opções a caixa de busca aparece.
 *
 * Com três ou quatro opções o olho acha mais rápido do que a mão digita, e a
 * busca vira ruído. A reclamação que originou este componente foi a lista de
 * modelos de IA — o OpenRouter devolve centenas — onde procurar no olho não
 * funciona.
 */
export const MINIMO_PARA_BUSCA = 8;

export interface SearchableSelectProps {
  options: readonly OpcaoDeSelecao[];
  value: string | undefined;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  minOptionsForSearch?: number;
}

/** Índice do valor atual, se der para escolhê-lo; senão, a primeira opção habilitada. */
function primeiroDestaque(lista: readonly OpcaoDeSelecao[], valor?: string): number {
  const doValor = valor ? lista.findIndex((o) => o.value === valor && !o.disabled) : -1;
  return doValor >= 0 ? doValor : lista.findIndex((o) => !o.disabled);
}

/** Próxima opção habilitada na direção `passo`; parada na borda em vez de dar a volta. */
function proximoHabilitado(lista: readonly OpcaoDeSelecao[], de: number, passo: 1 | -1): number {
  for (let i = de + passo; i >= 0 && i < lista.length; i += passo) {
    if (!lista[i]?.disabled) return i;
  }
  return de;
}

/**
 * Caixa de seleção com busca. Por que não é o `Select` do Radix com um input
 * dentro: o typeahead do Radix rouba as teclas digitadas e o hover rouba o
 * foco — ver `docs/superpowers/plans/2026-10-03-caixas-de-selecao-com-busca.md`.
 *
 * Os papéis ARIA são os mesmos do `Select` (gatilho `combobox`, itens
 * `option`), então quem testava a tela pelos papéis continua achando tudo.
 */
export function SearchableSelect({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
  minOptionsForSearch = MINIMO_PARA_BUSCA,
}: SearchableSelectProps) {
  const t = useT();
  const listaId = React.useId();
  const buscaRef = React.useRef<HTMLInputElement>(null);
  const listaRef = React.useRef<HTMLUListElement>(null);
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const [destacado, setDestacado] = React.useState(-1);

  const comBusca = options.length >= minOptionsForSearch;
  const visiveis = React.useMemo(() => filtrarOpcoes(options, busca), [options, busca]);
  // Valor fora da lista (modelo digitado à mão, item que saiu do catálogo)
  // aparece cru. Gatilho em branco faria parecer que nada foi escolhido.
  const rotulo = options.find((o) => o.value === value)?.label ?? (value || "");
  const textoDaBusca = searchPlaceholder ?? t("Buscar…");
  const idDoDestacado = destacado >= 0 ? `${listaId}-${destacado}` : undefined;

  React.useEffect(() => {
    if (!aberto || !idDoDestacado) return;
    // `?.` na chamada: o jsdom não implementa scrollIntoView.
    document.getElementById(idDoDestacado)?.scrollIntoView?.({ block: "nearest" });
  }, [aberto, idDoDestacado]);

  function abrir(buscaInicial = "") {
    setBusca(buscaInicial);
    setDestacado(primeiroDestaque(filtrarOpcoes(options, buscaInicial), buscaInicial ? undefined : value));
    setAberto(true);
  }

  function escolher(opcao: OpcaoDeSelecao) {
    if (opcao.disabled) return;
    onValueChange(opcao.value);
    setAberto(false);
  }

  function aoDigitar(texto: string) {
    setBusca(texto);
    setDestacado(primeiroDestaque(filtrarOpcoes(options, texto)));
  }

  function aoTeclarNaLista(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestacado((i) => proximoHabilitado(visiveis, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((i) => proximoHabilitado(visiveis, i, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setDestacado(proximoHabilitado(visiveis, -1, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setDestacado(proximoHabilitado(visiveis, visiveis.length, -1));
    } else if (e.key === "Enter") {
      // preventDefault também impede o Enter de enviar um formulário em volta.
      e.preventDefault();
      const alvo = visiveis[destacado];
      if (alvo) escolher(alvo);
    }
  }

  function aoTeclarNoGatilho(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (aberto || disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      abrir();
    } else if (comBusca && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // O Select do Radix tinha typeahead no gatilho fechado; aqui a letra
      // digitada abre a caixa e já vira o começo da busca.
      e.preventDefault();
      abrir(e.key);
    }
  }

  return (
    // `modal`: dentro de um Dialog, o bloqueio de rolagem do Dialog impediria
    // rolar a lista com a roda do mouse (o conteúdo vai num portal fora dele).
    <Popover modal open={aberto} onOpenChange={(abrindo) => (abrindo ? abrir() : setAberto(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={aberto}
          aria-controls={listaId}
          aria-label={ariaLabel}
          data-testid={testId}
          data-placeholder={rotulo ? undefined : ""}
          disabled={disabled}
          onKeyDown={aoTeclarNoGatilho}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="line-clamp-1 text-left">{rotulo || placeholder}</span>
          <CaretDown size={16} className="shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-[12rem] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (comBusca ? buscaRef.current : listaRef.current)?.focus();
        }}
        onKeyDown={aoTeclarNaLista}
      >
        {comBusca ? (
          <div className="flex items-center gap-2 border-b px-3">
            <MagnifyingGlass size={16} className="shrink-0 opacity-50" aria-hidden />
            <input
              ref={buscaRef}
              value={busca}
              onChange={(e) => aoDigitar(e.target.value)}
              placeholder={textoDaBusca}
              aria-label={textoDaBusca}
              aria-controls={listaId}
              aria-activedescendant={idDoDestacado}
              autoComplete="off"
              className="h-9 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
            />
          </div>
        ) : null}
        {visiveis.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyMessage ?? t("Nenhum resultado")}
          </p>
        ) : (
          <ul
            ref={listaRef}
            id={listaId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={comBusca ? undefined : idDoDestacado}
            className="max-h-72 overflow-y-auto p-1 outline-hidden"
          >
            {visiveis.map((opcao, i) => (
              <li
                key={opcao.value}
                id={`${listaId}-${i}`}
                role="option"
                aria-selected={opcao.value === value}
                aria-disabled={opcao.disabled || undefined}
                className={cn(
                  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm",
                  i === destacado && "bg-accent text-accent-foreground",
                  opcao.disabled && "pointer-events-none opacity-50",
                )}
                onMouseMove={() => {
                  if (!opcao.disabled && i !== destacado) setDestacado(i);
                }}
                onClick={() => escolher(opcao)}
              >
                {opcao.label}
                {opcao.value === value ? (
                  <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                    <Check size={16} aria-hidden />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
