"use client";
/**
 * O chip de etiqueta — o `Badge` do design system, agora pintado (issue #1271,
 * fatia S6 da #852).
 *
 * ─── Por que um componente, e não a cor em cada tela ────────────────────────
 *
 * A mesma etiqueta aparece em oito lugares (lista de conversas, editores do
 * Inbox, painel do CRM, ficha e lista de contatos, kanban). Oito cópias da
 * mesma regra de cor divergem na primeira correção — e a regra aqui tem duas
 * partes que precisam andar juntas: a cor da etiqueta e o texto que fica legível
 * sobre ela.
 *
 * ─── Por que o texto NÃO é escolha de quem usa ──────────────────────────────
 *
 * `escolheAFrente` (`lib/branding/contraste.ts`) decide preto ou branco pela
 * razão de contraste — a mesma régua que decide o texto dos botões da marca, e
 * que responde pelo piso de 4,5 de cada tom (issue #2373). Deixar a cor do
 * texto para quem escolhe a etiqueta é o caminho mais curto para um chip
 * ilegível, e quem paga é quem atende, não quem configurou. A frente vem do
 * ESTILO calculado, nunca de classe: um `text-*` aqui (ou um `style` passado
 * por quem usa o chip) sobrescreveria o cálculo em silêncio — o teste
 * `tests/unit/chip-contraste-da-etiqueta.test.ts` vigia os dois caminhos.
 *
 * ─── Sem cor, exatamente o que existia ──────────────────────────────────────
 *
 * `variant="secondary"` continua sendo o padrão: a fatia acrescenta cor, não
 * redesenha o chip. Etiqueta sem cor sai idêntica à de antes — inclusive nos
 * testes que já contam com o token.
 */
import type { ReactNode } from "react";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { estiloDoChip } from "@/lib/tags/cor-da-etiqueta";
import { useCorDaEtiqueta } from "@/components/tags/CoresDasEtiquetas";

interface Props extends Omit<BadgeProps, "children"> {
  /** O nome como está no dado — a cor é buscada pela chave canônica. */
  tag: string;
  /**
   * Cor FORÇADA, para quem já tem o dado em mãos: a lista da tela de Tags (que
   * leu o vocabulário do servidor) e a prévia do seletor (que mostra o tom
   * escolhido antes de salvar). `undefined` = usa o mapa do provider, que é o
   * caso de todos os chips de lista.
   */
  cor?: string | null;
  /** Conteúdo extra ao lado do nome (o botão de remover dos editores). */
  children?: ReactNode;
}

export function ChipDeEtiqueta({ tag, cor, className, children, ...props }: Props) {
  const corDoProvider = useCorDaEtiqueta(tag);
  const efetiva = cor === undefined ? corDoProvider : cor;
  return (
    <Badge variant="secondary" className={cn(className)} style={estiloDoChip(efetiva)} {...props}>
      {tag}
      {children}
    </Badge>
  );
}
