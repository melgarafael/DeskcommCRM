"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { Phone, CaretLeft, UserCircle } from "@/lib/ui/icons";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

interface Props {
  conversation: ConversationWithContact;
  /** Some do DOM em `md:` pra cima — abaixo disso é o único jeito de voltar
   * pra lista, já que a conversa ocupa a tela inteira (ver `InboxLayout`). */
  onBack: () => void;
  /** Abre o mesmo `CRMSidePanel` do desktop dentro de um Sheet — a porta pro
   * contexto do cliente abaixo de `xl`, onde a coluna fixa não existe. */
  onOpenCrmPanel: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  // É EXATAMENTE o estado em que a passagem para humano deixa a conversa
  // (`performHumanHandoff`: 'ai_handling' → 'pending'), e o rótulo faltava — toda
  // conversa escalada mostrava `pending` cru no rosto do atendente. O
  // `conversationStatusSchema` não lista 'pending' porque valida ENTRADA da API;
  // quem escreve este estado é o motor, e a tela precisa saber lê-lo.
  pending: "Aguardando atendente",
  claimed: "Em atendimento",
  ai_handling: "IA atendendo",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({ conversation, onBack, onOpenCrmPanel }: Props) {
  const t = useT();
  const { user } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const retomar = useResumeAiAttendance();
  const [reassignOpen, setReassignOpen] = useState(false);

  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c);
  const phone = c?.phone_number ?? null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  /**
   * A conversa saiu do atendimento automático? As DUAS travas contam: o silêncio
   * na conversa e o `force_human` no contato. Olhar só o silêncio deixaria de
   * oferecer a volta justamente no caso em que ela mais falta — o contato travado
   * com a conversa já liberada, em que nenhum envio automático sai e nada na tela
   * explica por quê.
   */
  const silenciada =
    conversation.bot_silenced_until !== null && conversation.bot_silenced_until !== undefined;
  const emAtendimentoHumano =
    (silenciada || c?.force_human === true) && status !== "closed" && status !== "archived";

  return (
    // `flex-wrap` porque este header travava a LARGURA DA TELA INTEIRA. Ele
    // media 707px de `min-content` — a identidade do contato encolhia bem
    // (`min-w-0` + `truncate`), mas a barra de ações era `shrink-0` e não
    // quebrava. Como a coluna do meio do inbox é `1fr`, que é
    // `minmax(auto, 1fr)`, ela não podia ficar menor que esses 707px, e o
    // painel de CRM era empurrado 311px para fora da viewport em 1280px.
    //
    // Reorganizar em vez de esconder: acima de ~1440px o header fica IDÊNTICO ao
    // de antes (uma linha), e quando aperta a barra desce para a linha de baixo.
    // Nenhuma ação some — um menu "mais" esconderia o "Lembrar" que a spec
    // `canais-baseline` clica, e, pior, esconderia ação de quem atende.
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {/* A volta pra lista — sem ela, abaixo de `md` a conversa ocupa a tela
            inteira (ver `InboxLayout`) e não sobra jeito de sair dela. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 md:hidden"
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
        >
          <CaretLeft size={18} aria-hidden />
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{displayName}</h2>
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {t(STATUS_LABEL[status] ?? status)}
            </Badge>
            {/* Ao lado do estado, não escondido num painel: a pergunta "dá para
                escrever agora?" se faz ANTES de digitar, não depois de receber um
                `failed` com um código de cinco dígitos. */}
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
            {/* Sem esta marca, a conversa em que o robô está calado tem exatamente
                a mesma cara de uma conversa normal — e ninguém entende por que as
                respostas automáticas pararam. */}
            {emAtendimentoHumano && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]" data-testid="badge-atendimento-humano">
                Automático pausado
              </Badge>
            )}
          </div>
          {phone && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Phone size={11} weight="regular" aria-hidden /> {phone}
            </p>
          )}
        </div>
      </div>

      {/* `shrink-0` saiu daqui: era ele que impunha o piso de largura. Agora a
          barra pode encolher e quebrar internamente, e os botões continuam
          todos visíveis e clicáveis — só que em duas linhas quando preciso. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {isOpen && (
          <Button
            size="sm"
            variant="default"
            disabled={claim.isPending}
            onClick={() =>
              claim.mutate({
                conversation_id: conversation.id,
                expected_assignee: conversation.assigned_to_user_id,
              })
            }
          >
            {t("Assumir")}
          </Button>
        )}
        {isMineAssigned && (
          <Button
            size="sm"
            variant="outline"
            disabled={release.isPending}
            onClick={() => release.mutate({ conversation_id: conversation.id })}
          >
            {t("Liberar")}
          </Button>
        )}
        {/* A volta. Fica ANTES de transferir/fechar porque é a ação que a pessoa
            procura quando terminou o que tinha para fazer aqui. */}
        {emAtendimentoHumano && (
          <Button
            size="sm"
            variant="outline"
            disabled={retomar.isPending}
            data-testid="devolver-ao-automatico"
            onClick={() => retomar.mutate({ conversation_id: conversation.id })}
          >
            {retomar.isPending ? "Devolvendo..." : t("Devolver ao automático")}
          </Button>
        )}
        {status !== "closed" && status !== "archived" && (
          <Button size="sm" variant="outline" onClick={() => setReassignOpen(true)}>
            {t("Transferir")}
          </Button>
        )}
        {status !== "closed" && status !== "archived" && (
          <SnoozeButton
            conversationId={conversation.id}
            snoozeUntil={conversation.snooze_until ?? null}
          />
        )}
        {status !== "closed" && status !== "archived" && (
          <Button
            size="sm"
            variant="outline"
            disabled={close.isPending}
            onClick={() => {
              if (confirm("Fechar esta conversa?")) {
                close.mutate({ conversation_id: conversation.id });
              }
            }}
          >
            {t("Fechar")}
          </Button>
        )}
        {/* `xl:hidden` porque a partir de 1280px o painel lateral de CRM já
            está fixo na tela. Abaixo disso, este botão abre o MESMO painel
            (`CRMSidePanel`) dentro de um Sheet — era um link "Ver contato" que
            navegava pra fora da conversa; agora o contexto abre por cima sem
            perder o lugar no atendimento. Mesma condição de antes (só aparece
            com contato vinculado) e mesmo motivo de ficar de fora da largura
            mínima do header: uma porta só, não duas. */}
        {c?.id && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="xl:hidden"
            onClick={onOpenCrmPanel}
          >
            <UserCircle size={14} weight="regular" aria-hidden className="mr-1" />
            Cliente
          </Button>
        )}
      </div>
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
      />
    </div>
  );
}
