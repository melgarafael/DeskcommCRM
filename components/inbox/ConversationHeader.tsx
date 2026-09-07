"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { Phone, ArrowRight } from "@/lib/ui/icons";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import { useCloseConversation, useReopenConversation } from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact;
}

/**
 * O CHIP NOMEIA CICLO DE VIDA, NÃO COMANDO.
 *
 * Ele afirmava quem manda — "Automático atendendo", "Aguardando atendente" — a
 * 20px de um selo que responde a MESMA pergunta por outra fonte, e as duas se
 * contradiziam na tela: `conversations.status` não acompanha silêncio, trava de
 * contato nem atribuição, e o motor nunca o lê. Medido em 2026-08-30 num print
 * do dono: "Aguardando atendente" e "Automático" no mesmo cabeçalho.
 *
 * Quem responde "quem manda" é o `OwnerBadge`, que vem de `comandoDaConversa`.
 * Aqui fica só o que o status realmente sabe: o episódio está aberto ou acabou.
 *
 * Cobre os SETE valores do CHECK de propósito — o call site é
 * `t(STATUS_LABEL[status] ?? status)`, e um buraco imprime o token cru em inglês
 * no rosto do atendente. Vigiado pelo invariante de espelho.
 */
const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

export function ConversationHeader({ conversation }: Props) {
  const t = useT();
  const { user } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const reopen = useReopenConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" — sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();
  const [reassignOpen, setReassignOpen] = useState(false);

  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  /**
   * QUEM MANDA, uma pergunta com uma resposta.
   *
   * Este bloco era três leituras parciais. O selo e o botão de volta liam duas
   * travas (`bot_silenced_until || force_human`); a linha da lista lia uma, por
   * COR; o painel não lia nenhuma. Desde a 0173 há uma quarta situação —
   * "alguém assumiu" — e continuar somando condições à mão aqui é como as três
   * leituras divergiram em primeiro lugar. A regra mora em `lib/inbox`,
   * espelhando os gates que o MOTOR lê, e esta tela só a consome.
   */
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa({
    status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    automaticoDaOrg: automaticoDaOrg.data,
  });

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  /**
   * A VOLTA aparece sempre que há algo a devolver — inclusive em conversa
   * ENCERRADA. Antes ela era condicionada a `status !== "closed"`, e o resultado
   * era um beco sem saída medido: atendente assume, fecha, sai de férias; a
   * conversa fica com o automático parado e, para qualquer colega, sem NENHUMA
   * porta — "Liberar" só existe para o próprio dono e a rota recusa quem não é.
   * `devolverAtendimentoAoAgente` funciona nesse estado (o status fechado está na
   * lista de reativáveis), então esconder o botão escondia uma ação que existe.
   *
   * A condição é `travaVigente`, e NÃO `!automaticoAtivo`: conversa encerrada tem
   * o automático inativo sem ter trava nenhuma, e sair do segundo faria o botão
   * aparecer em toda conversa fechada — clicá-lo REABRIRIA uma conversa que
   * ninguém pediu para reabrir. Oferecer uma ação que não deveria acontecer é
   * pior que não oferecer nenhuma.
   */
  const podeDevolver = travaVigente;
  /**
   * PAUSAR só aparece quando pausar é um gesto DIFERENTE de assumir.
   *
   * Desde a 0173 "Assumir" já cala o automático (a RPC grava o silêncio). Numa
   * conversa sem dono, portanto, "Assumir" e "Pausar o automático" teriam
   * exatamente o mesmo efeito — dois botões para um ato é a confusão que esta
   * entrega existe para acabar, não para dobrar.
   *
   * Sobra o caso em que ele é próprio: a conversa JÁ tem dono e o automático
   * continua de pé. Isso é real e não é raro — o rodízio (`reason='routing'`)
   * distribui sem calar, de propósito, senão uma org em round_robin ficaria sem
   * automático nenhum.
   */
  const podePausar =
    automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null;

  if (user.support?.access_mode === "support_readonly") return <header className="flex items-center justify-between border-b p-4">
    <strong>{displayName}</strong><span className="text-sm text-muted-foreground">{STATUS_LABEL[status] ?? status} · Somente leitura</span>
  </header>;
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
              respostas automáticas pararam.
              O testid é o MESMO de antes de propósito: `escalacao-ciclo.spec.ts`
              o clica, e rótulo visível é contrato. O que mudou é o texto DIZER o
              motivo — "alguém assumiu" e "pausado para este cliente" pediam ações
              diferentes e tinham a mesma frase. */}
          {motivo !== null && (
            <Badge
              variant="outline"
              className="h-4 px-1.5 text-[10px]"
              data-testid="badge-atendimento-humano"
            >
              {t(ROTULO_DO_MOTIVO[motivo])}
            </Badge>
          )}
        </div>

        {/* QUEM ESTÁ NO COMANDO, com nome e por GEOMETRIA — disco cheio para
            pessoa, anel vazado para o automático. É o mesmo componente do card do
            funil e do dossiê: um terceiro jeito de dizer "quem manda", por cor ou
            por texto, faria a mesma pergunta ter três respostas diferentes na
            mesma tela. Cor não sobrevive ao daltonismo nem ao teste do metro. */}
        <div className="mt-1 flex items-center gap-2" data-testid="comando-da-conversa">
          {comando.quem === "humano" ? (
            <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} />
          ) : comando.quem === "automatico" ? (
            <OwnerBadge ownerKind="ai" ownerName={t("Automático")} />
          ) : (
            // `ninguem`, `aguardando` e `encerrada` sem dono caem aqui: o disco
            // TRACEJADO do OwnerBadge, que é como o funil já desenha "ninguém".
            <OwnerBadge ownerKind={null} ownerName={null} />
          )}
        </div>
        {phone && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Phone size={11} weight="regular" aria-hidden /> {phone}
          </p>
        )}
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
            // O rótulo NÃO muda (é contrato: `inbox-header-nao-trava` e o
            // dicionário de espanhol o citam). O que faltava era a consequência
            // dita: desde a 0173 assumir também para o atendimento automático, e
            // um botão que muda duas coisas precisa anunciar as duas.
            title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
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
        {/* O INTERRUPTOR. Um botão, dois rótulos, um slot.
            Fica ANTES de transferir/fechar porque é a ação que a pessoa procura
            quando terminou o que tinha para fazer aqui.

            Dois botões lado a lado foi medido e recusado: a barra de ações já
            estourou a caixa útil de 392px em 1280px uma vez (ver o comentário no
            topo do JSX), e um botão a mais custa ~85px — o cabeçalho ganharia uma
            segunda fileira justo na largura mais apertada. Os dois estados são
            mutuamente exclusivos, então nunca precisam existir juntos.

            O `data-testid` do lado de VOLTA é o mesmo de antes: `escalacao-ciclo`
            o clica, e rótulo/testid visível é contrato. */}
        {podeDevolver && (
          <Button
            size="sm"
            variant="outline"
            disabled={retomar.isPending}
            data-testid="devolver-ao-automatico"
            // O ALCANCE DA VOLTA NÃO É SEMPRE O MESMO, e a tela precisa dizer qual é.
            //
            // `devolverAtendimentoAoAgente` limpa `contacts.force_human`, que é do
            // CLIENTE e não desta conversa: quando foi ela que travou, o clique
            // religa o automático para TODAS as conversas daquela pessoa. Um botão
            // que às vezes faz mais do que o nome promete precisa dizer quando.
            title={
              motivo === "contato_travado"
                ? t("Religa o atendimento automático para este cliente — vale para todas as conversas dele.")
                : t("Devolve esta conversa ao atendimento automático.")
            }
            onClick={() => retomar.mutate({ conversation_id: conversation.id })}
          >
            {retomar.isPending ? t("Devolvendo...") : t("Devolver ao automático")}
          </Button>
        )}
        {podePausar && (
          <Button
            size="sm"
            variant="outline"
            disabled={pausar.isPending}
            data-testid="pausar-o-automatico"
            // `podePausar` já exige dono != null, então este botão NUNCA aparece
            // sem dono — prometer "você assume" aqui seria prometer o que a rota
            // não faz: com dono, ela só cala, nunca rouba a conversa de quem a tem.
            title={t("O atendimento automático para nesta conversa. O dono não muda.")}
            onClick={() => pausar.mutate({ conversation_id: conversation.id })}
          >
            {pausar.isPending ? t("Pausando...") : t("Pausar o automático")}
          </Button>
        )}
        {!encerrada && (
          <Button size="sm" variant="outline" onClick={() => setReassignOpen(true)}>
            {t("Transferir")}
          </Button>
        )}
        {!encerrada && (
          <SnoozeButton
            conversationId={conversation.id}
            snoozeUntil={conversation.snooze_until ?? null}
          />
        )}
        {!encerrada && (
          <Button
            size="sm"
            variant="outline"
            disabled={close.isPending}
            onClick={() => {
              if (confirm(t("Fechar esta conversa?"))) {
                close.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision });
              }
            }}
          >
            {t("Fechar")}
          </Button>
        )}
        {encerrada && <Button size="sm" variant="outline" disabled={reopen.isPending}
          onClick={() => reopen.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision })}>
          {t("Reabrir")}
        </Button>}
        {/* `xl:hidden` porque a partir de 1280px o painel lateral de CRM entra
            na tela — e ele já tem um "Ver contato", para o MESMO contato, a um
            palmo de distância. Duas portas idênticas na mesma tela não são
            redundância inofensiva: são a linha a mais que empurrava a barra de
            ações para uma segunda fileira justo na largura mais apertada.
            Medido: sem a duplicata, os botões voltam a caber em UMA linha em
            1280px.

            Abaixo de 1280 o painel não existe, e aí esta é a única porta para o
            contato — por isso a condição é a mesma do painel, e não um valor
            escolhido à parte. Não é esconder ação; é não repeti-la. */}
        {c?.id && (
          <Button asChild size="sm" variant="ghost" className="xl:hidden">
            <Link href={`/app/contacts/${c.id}`} className="flex items-center gap-1">
              {t("Ver contato")}
              <ArrowRight size={12} weight="regular" aria-hidden />
            </Link>
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
