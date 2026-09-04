"use client";
import Link from "next/link";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ChatCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";

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
 * Lead criado à mão ou por webhook não tem contato; contato pode não ter
 * conversa. Nesses casos o slot não aparece — e NÃO aparece um "sem mensagens"
 * cinza, que ocuparia a mesma linha em metade dos cards para não dizer nada.
 */
export function ConversaSlot({ conversa }: { conversa: Lead["conversa"] }) {
  const t = useT();
  if (!conversa) return null;

  const preview = conversa.preview?.trim();
  const temNaoLidas = conversa.unread > 0;

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
      <span className="truncate">
        {preview || <span className="italic">{t("conversa sem mensagens")}</span>}
      </span>
      {temNaoLidas && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
    </Link>
  );
}
