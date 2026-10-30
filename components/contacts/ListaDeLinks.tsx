"use client";

import type { MouseEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { TIPOS_DE_LINK } from "@/lib/leads/links-de-contato";

interface Props {
  /**
   * Links já prontos para exibir: a saída de `linksParaExibir` (ficha) ou a lista
   * do quadro já filtrada (card). Só apresenta — quem valida é a leitura.
   */
  links: ReadonlyArray<{ tipo: string; href: string }>;
  /**
   * Gancho opcional de clique. O card usa para `stopPropagation` (abrir o
   * Instagram de alguém não pode abrir o dossiê por cima); a ficha não passa nada.
   */
  aoClicarNoLink?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Os links do contato como botões de texto curto (IG, Site, Google…).
 *
 * Apresentação pura: não lê o banco nem o `custom_fields`. Mesmo assim só
 * renderiza o que começa com http(s) — defesa barata, na própria tela, para um
 * valor que chegue sem passar por `linksParaExibir`.
 */
export function ListaDeLinks({ links, aoClicarNoLink }: Props) {
  const t = useT();
  const seguros = links.filter(({ href }) => /^https?:\/\//i.test(href));

  if (seguros.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {seguros.map(({ tipo, href }) => {
        const definicao = TIPOS_DE_LINK.find((d) => d.id === tipo);
        const rotulo = definicao ? t(definicao.rotulo) : tipo;
        return (
          <a
            key={tipo}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={`${rotulo} — ${href}`}
            aria-label={`${t("Abrir")} ${rotulo}`}
            onClick={aoClicarNoLink}
            className="rounded-md border border-border px-1.5 py-0.5 text-[11px] leading-4 text-text-muted hover:border-accent hover:text-accent"
          >
            {definicao?.curto ?? tipo}
          </a>
        );
      })}
    </div>
  );
}
