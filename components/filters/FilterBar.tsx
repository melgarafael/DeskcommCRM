"use client";

import * as React from "react";

import { CaretDown, Funnel, MagnifyingGlass, X } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * O PADRÃO GLOBAL DE FILTROS — uma linguagem só para todas as listas.
 *
 * Hierarquia (§5 do padrão): a linha primária carrega busca + 1–2 selects que
 * resolvem ~80% dos usos; o resto mora em `FilterAdvanced` (colapsado); o que
 * está aplicado aparece em `FilterChips` (remoção individual + limpar tudo).
 * Filtros salvos vivem em `SavedFilters`, com o mesmo vocabulário em toda tela.
 *
 * Os textos vêm por props, sempre: estes componentes não conhecem idioma.
 */

// ---------------------------------------------------------------------------
// Barra — o invólucro. Não é Card de destaque: é a toolbar da lista.
// ---------------------------------------------------------------------------

export function FilterBar({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={`space-y-3 rounded-lg border bg-card p-3 sm:p-4 ${className}`}>{children}</section>;
}

/** Linha primária: busca cresce, selects têm largura fixa. Empilha no mobile. */
export function FilterPrimary({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 md:flex-row md:items-end">{children}</div>;
}

/** Linha de ações/rodapé: salvos à esquerda, resto à direita. */
export function FilterActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

// ---------------------------------------------------------------------------
// Busca — cresce, com ícone e botão de limpar.
// ---------------------------------------------------------------------------

export function FilterSearch({
  id,
  label,
  value,
  onChange,
  placeholder,
  className = "",
  dataTestId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (valor: string) => void;
  placeholder?: string;
  className?: string;
  /** Gancho para e2e — não muda comportamento. */
  dataTestId?: string;
}) {
  return (
    <div className={`w-full space-y-1.5 md:min-w-52 md:flex-1 ${className}`}>
      <Label htmlFor={id} className="block text-sm font-medium">
        {label}
      </Label>
      <div className="relative">
        <MagnifyingGlass
          size={16}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pr-8 pl-9"
          type="search"
          data-testid={dataTestId}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`${label}: limpar`}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select — altura e tipografia iguais às do Input, largura fixa no desktop.
// ---------------------------------------------------------------------------

export function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  allLabel,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (valor: string) => void;
  options: { value: string; label: string }[];
  /** Rótulo da opção vazia ("Todos", "Todas"…). Sem ele, não há opção vazia. */
  allLabel?: string;
  className?: string;
}) {
  return (
    <div className={`w-full space-y-1.5 sm:w-44 md:shrink-0 ${className}`}>
      <Label htmlFor={id} className="block text-sm font-medium">
        {label}
      </Label>
      <select
        id={id}
        className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allLabel !== undefined && <option value="">{allLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Número — par min/max com a mesma altura dos demais.
// ---------------------------------------------------------------------------

export function FilterNumber({
  id,
  label,
  value,
  onChange,
  placeholder,
  min = 0,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (valor: string) => void;
  placeholder?: string;
  min?: number;
  className?: string;
}) {
  return (
    <div className={`w-full space-y-1.5 sm:w-36 md:shrink-0 ${className}`}>
      <Label htmlFor={id} className="block text-sm font-medium">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avançados — colapsado por padrão, com contagem do que está aplicado.
// ---------------------------------------------------------------------------

export function FilterAdvanced({
  open,
  onToggle,
  toggleLabel,
  activeCount,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  toggleLabel: string;
  activeCount: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-expanded={open}
        className="gap-1.5 px-2 text-muted-foreground"
      >
        <Funnel size={14} aria-hidden />
        {toggleLabel}
        {activeCount > 0 && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[11px] leading-none font-medium text-primary-foreground">
            {activeCount}
          </span>
        )}
        <CaretDown
          size={14}
          aria-hidden
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open && (
        <div className="mt-2 flex flex-col gap-2 border-t pt-3 md:flex-row md:items-end md:gap-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chips — o que está aplicado, com remoção individual e limpar tudo.
// ---------------------------------------------------------------------------

export interface ActiveChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function FilterChips({
  chips,
  onClearAll,
  clearLabel,
}: {
  chips: ActiveChip[];
  onClearAll: () => void;
  clearLabel: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.onRemove}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/60 py-1 pr-1.5 pl-2.5 text-xs hover:bg-muted"
          title={c.label}
        >
          <span className="truncate">{c.label}</span>
          <X size={12} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="sr-only">remover</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {clearLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Salvos — salvar, aplicar, excluir. A persistência é da página.
// ---------------------------------------------------------------------------

export function SavedFilters({
  names,
  onApply,
  onSave,
  onRemove,
  texts,
}: {
  names: string[];
  onApply: (nome: string) => void;
  onSave: (nome: string) => void;
  onRemove: (nome: string) => void;
  texts: { savePlaceholder: string; saveButton: string; applyPlaceholder: string; removeLabel: string };
}) {
  const [nome, setNome] = React.useState("");
  const [aplicado, setAplicado] = React.useState("");

  function salvar() {
    const limpo = nome.trim();
    if (!limpo) return;
    onSave(limpo);
    setNome("");
    setAplicado(limpo);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        className="h-8 w-40"
        value={nome}
        onChange={(e) => setNome(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") salvar();
        }}
        placeholder={texts.savePlaceholder}
        aria-label={texts.savePlaceholder}
      />
      <Button size="sm" variant="outline" disabled={!nome.trim()} onClick={salvar}>
        {texts.saveButton}
      </Button>
      {names.length > 0 && (
        <>
          <select
            className="h-8 rounded-lg border bg-background px-2 text-sm"
            value={aplicado}
            onChange={(e) => {
              setAplicado(e.target.value);
              if (e.target.value) onApply(e.target.value);
            }}
            aria-label={texts.applyPlaceholder}
          >
            <option value="">{texts.applyPlaceholder}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {aplicado && names.includes(aplicado) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onRemove(aplicado);
                setAplicado("");
              }}
              aria-label={`${texts.removeLabel}: ${aplicado}`}
              className="h-8 px-2 text-muted-foreground"
            >
              <X size={14} aria-hidden />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
