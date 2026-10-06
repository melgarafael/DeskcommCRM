"use client";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { TETO_DE_ETIQUETAS_NO_FILTRO } from "@/lib/agent-engine/agent/filtro-de-etiquetas";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";

/** Quantas sugestões aparecem de uma vez; digitar filtra as demais. */
const SUGESTOES_VISIVEIS = 12;

interface Props {
  id: string;
  rotulo: string;
  ajuda: string;
  value: readonly string[];
  /**
   * Lista vazia sai como `undefined`: chave ausente é o que a versão salva
   * tem, e só ela bate com o formulário na hora de liberar o Publicar
   * (`lib/ai/agents/mesmo-rascunho.ts`).
   */
  onChange: (next: string[] | undefined) => void;
  /** Etiquetas em uso nos contatos da organização. */
  sugestoes?: readonly string[];
  disabled?: boolean;
}

/** Campo de etiquetas do filtro do agente — grava já normalizado, como o servidor guarda. */
export function EtiquetasDoFiltroInput({ id, rotulo, ajuda, value, onChange, sugestoes = [], disabled }: Props) {
  const t = useT();
  const [rascunho, setRascunho] = React.useState("");
  const cheio = value.length >= TETO_DE_ETIQUETAS_NO_FILTRO;

  function adicionar(cru: string) {
    const tag = normalizarTag(cru);
    if (tag === "" || value.includes(tag) || cheio) return;
    onChange([...value, tag]);
    setRascunho("");
  }

  function remover(tag: string) {
    const resto = value.filter((x) => x !== tag);
    onChange(resto.length > 0 ? resto : undefined);
  }

  const busca = normalizarTag(rascunho);
  const oferecidas = sugestoes
    .filter((s) => !value.includes(s) && (busca === "" || s.includes(busca)))
    .slice(0, SUGESTOES_VISIVEIS);
  // Etiqueta que nenhum contato tem: quase sempre erro de digitação — e, num
  // "só quem tem", um erro desses cala o agente para todo mundo.
  const desconhecidas = sugestoes.length > 0 ? value.filter((v) => !sugestoes.includes(v)) : [];

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{rotulo}</Label>
      <div className="flex flex-wrap gap-1 rounded-md border border-border/60 p-2">
        {value.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => !disabled && remover(tag)}
            className="group flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs hover:bg-destructive/15"
            disabled={disabled}
            aria-label={`${t("Remover")} ${tag}`}
          >
            {tag}
            <span className="text-muted-foreground group-hover:text-destructive">×</span>
          </button>
        ))}
        {value.length === 0 ? <span className="text-xs text-muted-foreground">{t("Nenhuma etiqueta.")}</span> : null}
      </div>
      <div className="flex gap-2">
        <Input
          id={id}
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              adicionar(rascunho);
            }
          }}
          placeholder={t("Digite uma etiqueta e aperte Enter")}
          disabled={disabled || cheio}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
        />
        <button
          type="button"
          className="rounded-md border border-border/60 px-3 text-xs hover:bg-muted"
          onClick={() => adicionar(rascunho)}
          disabled={disabled || rascunho.trim() === ""}
        >
          {t("Adicionar")}
        </button>
      </div>
      {oferecidas.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {oferecidas.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => adicionar(s)}
              disabled={disabled || cheio}
              className="rounded-md border border-dashed border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
      {desconhecidas.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("Nenhum contato tem esta etiqueta ainda:")} {desconhecidas.join(", ")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{ajuda}</p>
    </div>
  );
}
