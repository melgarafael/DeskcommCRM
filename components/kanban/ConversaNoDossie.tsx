"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { ArrowRight, ChatCircle } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";
import { AbrirConversaDoLead, temAlvoParaAbrir } from "./AbrirConversaDoLead";

/**
 * A porta para a conversa, dentro do dossiê.
 *
 * ─── Por que não bastava o atalho do card ───────────────────────────────────
 *
 * O card tem o atalho desde o PR do quadro, e ele funciona. Mas o dossiê é para
 * onde se vai quando a pergunta é "o que está acontecendo com este negócio?" — e
 * lá dentro a linha do tempo ANUNCIA "Entrou no funil / primeira mensagem
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
 *
 * ─── Sem conversa, mas com contato: a AÇÃO (issue #1993) ─────────────────────
 *
 * O lead do webhook chega com telefone e sem thread. Para ele o bloco não some:
 * vira o botão "Abrir conversa", que reaproveita a rota já existente, abre (ou
 * reabre) a conversa do contato e leva para a Inbox. `contactId`/`phone` são
 * opcionais porque a tela de CONTATO ainda não os passa — sem eles o bloco
 * continua sumindo, como antes.
 */
export function ConversaNoDossie({
  conversa,
  contactId,
  phone,
}: {
  conversa: Contact["conversa"] | null | undefined;
  contactId?: string | null;
  phone?: string | null;
}) {
  const t = useT();
  if (conversa === undefined) return null;
  if (conversa === null) {
    // Mesma guarda do card, antes de montar: sem contato e sem telefone o bloco
    // continua sumindo (regra de sempre), em vez de desenhar um botão mudo.
    return temAlvoParaAbrir(contactId, phone) ? (
      <AbrirConversaDoLead contactId={contactId} phone={phone} variante="dossie" />
    ) : null;
  }

  const preview = conversa.preview?.trim();

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      className="group mt-3 flex items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted"
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
