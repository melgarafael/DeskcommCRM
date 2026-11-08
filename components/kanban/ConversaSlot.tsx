"use client";
import Link from "next/link";
import type { MouseEvent } from "react";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { dataEHoraCompletas, horaCurta } from "@/lib/i18n/hora-curta";
import { ChatCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";
import { AbrirConversaDoLead, temAlvoParaAbrir } from "./AbrirConversaDoLead";

/**
 * A última mensagem do negócio, com atalho para o inbox.
 *
 * ─── Por que atalho e não um composer aqui dentro ───────────────────────────
 *
 * Responder de dentro do quadro exigiria trazer o composer inteiro — anexos,
 * templates, notas internas, gravação de áudio — para uma segunda tela. Duas
 * cópias do mesmo campo divergem: a correção entra numa e não na outra, e o
 * atendente aprende que "no Kanban não funciona igual". O inbox já é o lugar
 * onde se conversa; o que faltava era chegar nele sem procurar.
 *
 * ─── O que a prévia resolve ─────────────────────────────────────────────────
 *
 * Sem ela o atalho é uma aposta: clicar para descobrir se vale a pena. Com a
 * última mensagem à vista, o vendedor decide olhando o quadro — que é para o
 * que o quadro serve.
 *
 * ─── Ausência é estado normal, não erro ─────────────────────────────────────
 *
 * Negócio criado à mão ou por webhook não tem contato; contato pode não ter
 * conversa. Nesses casos o slot não aparece — e NÃO aparece um "sem mensagens"
 * cinza, que ocuparia a mesma linha em metade dos cards para não dizer nada.
 *
 * ─── Sem conversa, mas com contato: a AÇÃO no lugar da prévia ────────────────
 *
 * O lead do webhook chega com telefone e sem thread (issue #1993). Para ele a
 * linha não some: vira o botão "Abrir conversa", que usa a rota já existente e
 * leva para a Inbox. `conversa === undefined` continua mudo — é "ainda não
 * carregou", e prometer ação sobre um dado que pode existir seria mentir.
 */
export function ConversaSlot({
  conversa,
  contactId,
  phone,
}: {
  conversa: Lead["conversa"];
  contactId?: string | null;
  phone?: string | null;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  if (conversa === undefined) return null;
  if (conversa === null) {
    // A guarda de alvo fica AQUI, antes de montar: montar o botão sem contato
    // nem telefone desenharia (e custaria router + query client) uma linha que
    // não tem o que dizer.
    return temAlvoParaAbrir(contactId, phone) ? (
      <AbrirConversaDoLead contactId={contactId} phone={phone} />
    ) : null;
  }

  const preview = conversa.preview?.trim();
  const temNaoLidas = conversa.unread > 0;
  // ─── A HORA DA ÚLTIMA MENSAGEM (fatia 1 do #3945) ─────────────────────────
  //
  // O `last_message_at` já vinha no payload do quadro desde a #1993 e o card o
  // ignorava: a prévia dizia O QUE a pessoa falou e não QUANDO. "Quero saber o
  // preço" é a mesma frase hoje e há três semanas, e a diferença entre as duas
  // é a decisão inteira de quem olha o funil.
  //
  // A régua é `horaCurta` — a MESMA da linha da Inbox, extraída para
  // `lib/i18n/hora-curta.ts`. Duas contas do mesmo "quando" divergiriam no
  // primeiro ajuste. `title` guarda a data completa: o curto omite de propósito,
  // esconder não é o mesmo que ser compacto.
  const hora = horaCurta(conversa.last_message_at, locale);
  const horaCompleta = dataEHoraCompletas(conversa.last_message_at, locale);

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      // O card inteiro é arrastável e clicável (abre o dossiê). Sem parar a
      // propagação, o clique no atalho também abriria o dossiê por baixo — dois
      // destinos para um gesto.
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onPointerDown={(e: MouseEvent) => e.stopPropagation()}
      className={cn(
        "group/conversa mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px]",
        "text-text-muted transition-colors hover:bg-muted hover:text-foreground",
      )}
      title={t("Abrir esta conversa no Inbox")}
    >
      <ChatCircle size={12} weight="regular" className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {preview || <span className="italic">{t("conversa sem mensagens")}</span>}
      </span>
      {(hora || temNaoLidas) && (
        // Hora e não-lidas no mesmo grupo à direita: um bloco só, alinhado, em
        // vez de dois `ml-auto` brigando por quem empurra quem.
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {hora && (
            <time
              dateTime={conversa.last_message_at ?? undefined}
              title={horaCompleta || undefined}
              // `data-hora-da-mensagem` é o observável do teste: o card precisa
              // mostrar QUANDO, e um texto qualquer na linha não prova isso.
              data-hora-da-mensagem={hora}
              className="whitespace-nowrap tabular-nums text-[10px]"
            >
              {hora}
            </time>
          )}
          {temNaoLidas && (
            // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
            // diferentes, e um ponto colapsa as duas.
            <span
              className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground tabular-nums"
              aria-label={`${conversa.unread} ${t("sem ler")}`}
            >
              {conversa.unread}
            </span>
          )}
        </span>
      )}
    </Link>
  );
}
