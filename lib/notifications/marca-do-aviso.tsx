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

/**
 * O ícone da rede + o nome dela em texto para leitor de tela.
 *
 * `colorido: false` mantém o logo e o nome e troca só o token da cor pelo
 * neutro do tema — é o que a empresa desliga em Configurações › Notificações.
 * Esconder o logo junto tiraria a marca que não é cor (daltonismo, leitor de
 * tela); o que sai de cena é a cor, não a informação.
 */
export function MarcaDoCanal({ canal, colorido = true }: { canal?: string | null; colorido?: boolean }) {
  const marca = marcaDoCanal(canal);
  const rotulo = rotuloAcessivelDoCanal(marca, idiomaAtual());
  const Icone = marca.Icone;
  const cor = colorido ? marca.cor : marcaDoCanal(null).cor;
  return (
    <span className="inline-flex items-center" style={{ color: cor }} title={rotulo}>
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
  colorido = true,
): { icon: ReactNode; style: CSSProperties } | null {
  if (canal === undefined || canal === null) return null;
  // Desligada a cor, a faixa vira a borda neutra do tema: o aviso CONTINUA
  // dizendo de onde veio (logo + nome no texto) e volta a parecer o de antes
  // — que é exatamente o pedido de quem desliga.
  const marca = marcaDoCanal(colorido ? canal : null);
  return {
    icon: createElement(MarcaDoCanal, colorido ? { canal } : { canal, colorido: false }),
    style: { borderLeft: `3px solid ${marca.cor}` },
  };
}
