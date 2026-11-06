"use client";

import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import type { Resolvedor } from "@/lib/variaveis/catalogo";
import { previaDoTexto } from "@/lib/variaveis/previa";

/**
 * A PRÉVIA DO QUE O CLIENTE VAI LER (#3687).
 *
 * Resolve o texto com o contato de exemplo, pelo MESMO resolvedor da tela. É o
 * que transforma "variável que não existe aqui" em algo visível ANTES de salvar:
 * `{{telefone}}` na campanha continua `{{telefone}}` na prévia, exatamente como
 * chegaria ao contato.
 *
 * Some quando o texto não tem marcação — prévia de texto sem variável é o
 * próprio texto, e repetir a frase inteira na tela só ocupa espaço.
 */
export function PreviaComValores({
  texto,
  fonte,
  rotulo,
}: {
  texto: string;
  fonte: Resolvedor;
  /** Cabeçalho; o padrão é "Prévia". */
  rotulo?: string;
}) {
  const t = useT();
  if (!texto.includes("{{")) return null;
  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-elevated/40 p-2">
      <p className="text-xs font-medium text-muted-foreground">{rotulo ?? t("Prévia")}</p>
      <p className="text-sm whitespace-pre-line text-text-muted">{previaDoTexto(texto, fonte)}</p>
    </div>
  );
}
