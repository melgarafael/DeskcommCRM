"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A FOTO DO CONTATO no card do funil.
 *
 * A foto já existia no produto: o cron `contact-avatars` baixa a foto de perfil
 * do WhatsApp para o bucket privado e a lista do Inbox a mostra
 * (`ConversationListItem`). O card do funil era a única vitrine do contato sem
 * rosto — e é nele que o vendedor decide em quem mexer.
 *
 * ─── Por que `<img>` nativa, e não o `Avatar` do Radix (revisão do #5007) ──
 *
 * O `AvatarImage` do Radix pré-carrega com `new Image()` para TODO card
 * montado, e isso anula o `loading="lazy"`. O quadro monta até 50 cards por
 * coluna; cada foto passa por `/api/v1/contacts/[id]/avatar`, que devolve URL
 * assinada nova a cada chamada — o navegador não reaproveita os bytes. Num quadro
 * grande, cada abertura viraria muitos MB de tráfego do Supabase, que é a cota
 * que mais aperta no plano grátis. A `<img loading="lazy">` nativa só pede a
 * foto quando o card entra na tela.
 *
 * ─── Sem foto, sem disco ───────────────────────────────────────────────────
 *
 * O rodapé do card já tem o disco de iniciais do RESPONSÁVEL (`OwnerBadge`). Um
 * segundo disco de iniciais, do contato, não diria quem é quem. Então:
 *  - o componente só é montado quando o quadro disse que HÁ foto
 *    (`contact_has_avatar`, que já vem falso para o contato anonimizado);
 *  - se a imagem falhar (arquivo removido, rota fora), ela some — nunca um
 *    ícone de imagem quebrada no card.
 *
 * Tamanho FIXO nos dois modos: o card tem orçamento de altura, e a foto cabe na
 * linha do título (h-10 normal, h-5 compacto) sem empurrar nada.
 */
interface Props {
  contactId: string;
  denso?: boolean;
}

export function FotoDoContato({ contactId, denso = false }: Props) {
  const [falhou, setFalhou] = useState(false);
  if (falhou) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a rota devolve URL assinada por pedido; o otimizador do Next não tem o que guardar
    <img
      data-testid="foto-do-contato"
      src={`/api/v1/contacts/${contactId}/avatar`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFalhou(true)}
      className={cn(
        "shrink-0 rounded-full bg-surface-elevated object-cover",
        denso ? "h-5 w-5" : "mt-0.5 h-8 w-8",
      )}
    />
  );
}
