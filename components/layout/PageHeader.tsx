"use client";

import * as React from "react";

/**
 * O cabeçalho canônico das páginas: título, descrição curta e ações.
 *
 * A ação principal é o primeiro filho de `actions` com variant default; as
 * demais são secundárias. No mobile, empilha (título em cima, ações embaixo).
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-text">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
