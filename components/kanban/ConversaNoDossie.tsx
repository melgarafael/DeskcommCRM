"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { ArrowRight, ChatCircle } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";

/**
 * A porta para a conversa, dentro do dossiê.
 *
 * ─── Por que não bastava o atalho do card ───────────────────────────────────
 *
 * O card tem o atalho desde o PR do quadro, e ele funciona. Mas o dossiê é para
 * onde se vai quando a pergunta é "o que está acontecendo com este negócio?" — e
 * lá dentro a linha do tempo ANUNCIA "Entrou pelo WhatsApp / primeira mensagem
 * recebida no WhatsApp" e não oferece nenhum jeito de abrir essa conversa.
 *
 * Anunciar um canal e não dar a porta é pior que não anunciar: quem lê procura,
 * não acha, e fecha o painel para ir caçar a conversa na mão no inbox. Foi
 * exatamente esse o caminho do usuário que pediu isto — ele abriu o dossiê
 * justamente porque é onde a informação mora.
 *
 * ─── Por que aqui é um bloco, e no card é uma linha ─────────────────────────
 *
 * No card o espaço é disputado por oito outras coisas e a prévia precisa caber
 * em uma linha discreta. No dossiê não há disputa, e o alvo de clique pode ser
 * grande o suficiente para ser óbvio — que é o defeito que se está consertando.
 *
 * Ausência continua sendo estado normal: negócio criado à mão não tem contato, e
 * contato pode não ter conversa. Nesses casos o bloco não aparece, em vez de um
 * "sem conversa" cinza que ocuparia o mesmo espaço para não dizer nada.
 */
export function ConversaNoDossie({
  conversa,
}: {
  conversa: Contact["conversa"] | null | undefined;
}) {
  const t = useT();
  if (!conversa) return null;

  const preview = conversa.preview?.trim();

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      className="group mt-3 flex items-center gap-2.5 rounded-2xl border border-border bg-muted/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted"
    >
      <ChatCircle size={16} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-text">{t("Abrir conversa no Inbox")}</span>
        {preview && (
          // A última mensagem responde "vale a pena entrar agora?" sem entrar —
          // sem ela o botão é uma aposta, e o dossiê já existe para não obrigar
          // a abrir outra tela para saber.
          <span className="block truncate text-[11px] text-text-muted">{preview}</span>
        )}
      </span>
      {conversa.unread > 0 && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
      <ArrowRight
        size={14}
        weight="regular"
        className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}
