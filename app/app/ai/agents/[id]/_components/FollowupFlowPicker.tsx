"use client";
/**
 * Multi-select de fluxos de follow-up PUBLICADOS (status='active') pra
 * vincular ao agente (Task 7.2). Mesmo padrão de `ToolPicker.tsx` (fieldset +
 * checkboxes), trocando o catálogo MCP pela lista de `useFollowupFlows`
 * filtrada client-side — a rota `GET /api/v1/ai/followup-flows` não expõe
 * `?status=` ainda (checado; escopo mínimo não pediu mudança de rota).
 */
import * as React from "react";
import Link from "next/link";

import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function FollowupFlowPicker({ value, onChange, disabled }: Props) {
  const query = useFollowupFlows();

  const publishedFlows = React.useMemo(
    () => (query.data ?? []).filter((f) => f.status === "active"),
    [query.data],
  );

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  }

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando fluxos publicados…</p>;
  }
  if (query.isError) {
    return <p className="text-sm text-destructive">Erro ao carregar fluxos.</p>;
  }
  if (publishedFlows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nenhum fluxo publicado ainda.{" "}
        <Link href="/app/ai/followups" className="underline underline-offset-2 hover:text-foreground">
          Publique um fluxo de follow-up
        </Link>{" "}
        para vinculá-lo.
      </p>
    );
  }

  return (
    <fieldset className="space-y-2 rounded-md border border-border/60 p-3">
      <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Fluxos publicados
      </legend>
      {publishedFlows.map((f) => {
        const checked = value.includes(f.id);
        return (
          <label
            key={f.id}
            className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-muted/40"
          >
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-border accent-primary"
              checked={checked}
              onChange={() => toggle(f.id)}
              disabled={disabled}
              aria-label={f.name}
            />
            <span className="flex-1 text-sm">{f.name}</span>
          </label>
        );
      })}
      {value.length > 20 ? (
        <p className="text-xs text-destructive">Máximo de 20 fluxos por agent.</p>
      ) : null}
    </fieldset>
  );
}
