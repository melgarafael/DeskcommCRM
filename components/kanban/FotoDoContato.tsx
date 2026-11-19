"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { iniciaisDe } from "@/components/agenda/paleta";
import { cn } from "@/lib/utils";

/**
 * A FOTO DO CONTATO no card do funil.
 *
 * A foto já existia no produto: o cron `contact-avatars` baixa a foto de perfil
 * do WhatsApp para o bucket privado e a lista do Inbox a mostra
 * (`ConversationListItem`). O card do funil era a única vitrine do contato sem
 * rosto — e é nele que o vendedor decide em quem mexer.
 *
 * Mesma regra da lista do Inbox:
 *
 *  - a `<img>` só monta quando o quadro disse que HÁ foto (`contact_has_avatar`):
 *    sem isso o navegador pediria a rota para TODO card e levaria 404 na
 *    maioria, que não tem foto;
 *  - as iniciais ficam por baixo (`AvatarFallback`), então foto que não carrega
 *    nunca deixa o disco vazio;
 *  - contato anonimizado não chega aqui com foto: o quadro não marca
 *    `contact_has_avatar` para ele (`anexarDadosDoContato`).
 *
 * Negócio SEM contato não monta o componente (quem decide é o card): não há de
 * quem ser a foto, e um disco "?" afirmaria um contato que não existe.
 *
 * Tamanho FIXO nos dois modos: o card tem orçamento de altura, e o disco cabe
 * na linha do título (h-10 normal, h-5 compacto) sem empurrar nada.
 */
interface Props {
  contactId: string;
  temFoto: boolean;
  /** O nome que o card já mostra — de onde saem as iniciais. */
  nome: string;
  denso?: boolean;
}

export function FotoDoContato({ contactId, temFoto, nome, denso = false }: Props) {
  return (
    <Avatar
      data-testid="foto-do-contato"
      className={cn("shrink-0", denso ? "h-5 w-5" : "mt-0.5 h-8 w-8")}
    >
      {temFoto ? (
        <AvatarImage
          src={`/api/v1/contacts/${contactId}/avatar`}
          alt=""
          className="object-cover"
          loading="lazy"
        />
      ) : null}
      <AvatarFallback
        className={cn(
          "bg-surface-elevated font-medium text-text-muted",
          denso ? "text-[9px]" : "text-[11px]",
        )}
      >
        {/* O telefone puro vira "+5" — iniciais de número não dizem nada. */}
        {/^[\d\s()+-]+$/.test(nome.trim()) ? "" : iniciaisDe(nome)}
      </AvatarFallback>
    </Avatar>
  );
}
