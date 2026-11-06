"use client";

/**
 * A marca do canal dentro do aviso de mensagem nova (issue #4094, saída 2).
 *
 * ═══ Por que faixa + ícone, e não o fundo do toast pintado ═══
 *
 * O pedido original era "o aviso na cor do WhatsApp". Fundo colorido tem dois
 * problemas medidos: (a) o toast não sabe em que tema está — um verde de marca
 * sobre fundo escuro derruba o contraste do texto, e foi justamente por isso
 * que o `<Toaster>` usa `richColors` só para sucesso/erro; (b) com dez avisos
 * na tela, dez blocos coloridos viram ruído e param de informar. Uma faixa de
 * 3px na borda esquerda + o logo da rede dizem a mesma coisa sem tocar no
 * fundo, no texto e no contraste.
 *
 * A cor vem de token (`--color-canal-*`, definido para claro e escuro em
 * `app/globals.css`) aplicada por `style` inline: o CSS do sonner é
 * NÃO-camadado, e neste projeto (Tailwind v4) utilitário de camada perde para
 * ele independentemente de especificidade — `border-l-4` simplesmente não
 * pegaria. Inline resolve sem `!important` e sem regra global nova.
 */
import { type CSSProperties, type ReactNode, createElement } from "react";

import { marcaDoCanal, rotuloAcessivelDoCanal } from "@/lib/channels/marca-do-canal";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

/** O ícone da rede + o nome dela em texto para leitor de tela. */
export function MarcaDoCanal({ canal }: { canal?: string | null }) {
  const marca = marcaDoCanal(canal);
  const rotulo = rotuloAcessivelDoCanal(marca, idiomaAtual());
  const Icone = marca.Icone;
  return (
    <span className="inline-flex items-center" style={{ color: marca.cor }} title={rotulo}>
      {Icone ? <Icone size={18} weight="fill" aria-hidden /> : null}
      {/* Cor não é informação acessível: daltonismo não distingue a faixa. */}
      <span className="sr-only">{rotulo}</span>
    </span>
  );
}

/**
 * O que o aviso precisa para mostrar o canal. Devolve `null` quando o chamador
 * não declarou canal nenhum — e aí o toast sai exatamente como sempre foi
 * (lead, menção, exportação), sem `icon` e sem `style`.
 */
export function aderecosDoAviso(
  canal?: string | null,
): { icon: ReactNode; style: CSSProperties } | null {
  if (canal === undefined || canal === null) return null;
  const marca = marcaDoCanal(canal);
  return {
    icon: createElement(MarcaDoCanal, { canal }),
    style: { borderLeft: `3px solid ${marca.cor}` },
  };
}
