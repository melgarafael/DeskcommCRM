"use client";
import { useState, type RefObject } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { Phone, ArrowRight, MagnifyingGlass, CaretDown, CaretUp, IdentificationCard } from "@/lib/ui/icons";
import { EtapaDoFunilHeader } from "./EtapaDoFunilHeader";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import {
  useMarkPersonalContact,
  useUnmarkPersonalContact,
} from "@/hooks/contacts/usePersonalContact";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  useArchiveConversation,
  useCloseConversation,
  useReopenConversation,
} from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { FaixaDaCarteira } from "@/components/inbox/FaixaDaCarteira";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import { DialButton } from "@/components/voice/DialButton";
import { VideoCallButton } from "@/components/inbox/VideoCallButton";
import { motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";

interface Props {
  conversation: ConversationWithContact;
  /**
   * A busca DENTRO da conversa (#1793): abre um campo que filtra só as
   * mensagens já carregadas. O ref devolve o foco a este botão quando o campo
   * fecha — senão o Esc largava o foco no `body`.
   */
  onBuscar?: () => void;
  buscaAberta?: boolean;
  botaoBuscaRef?: RefObject<HTMLButtonElement | null>;
  /** Seleciona outra conversa no Inbox — a aba Número do Transferir abre a do outro número. */
  onAbrirConversa?: (id: string) => void;
  fichaRecolhida?: boolean;
  onToggleFicha?: () => void;
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

export function ConversationHeader({
  conversation,
  onAbrirConversa,
  onBuscar,
  buscaAberta,
  botaoBuscaRef,
  fichaRecolhida,
  onToggleFicha,
}: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const reopen = useReopenConversation();
  const arquivar = useArchiveConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" — sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [confirmFecharOpen, setConfirmFecharOpen] = useState(false);
  const [confirmArquivarOpen, setConfirmArquivarOpen] = useState(false);
  const [confirmPessoalOpen, setConfirmPessoalOpen] = useState(false);
  const [recolhido, setRecolhido] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const salvo = localStorage.getItem("deskcomm:inbox-header-collapsed");
      if (salvo !== null) return salvo === "true";
      return window.innerWidth < 768; // Celular comeca recolhido para liberar o chat
    } catch {
      return false;
    }
  });

  const alternarRecolhido = () => {
    setRecolhido((ant) => {
      const prox = !ant;
      try {
        localStorage.setItem("deskcomm:inbox-header-collapsed", String(prox));
      } catch {}
      return prox;
    });
  };

  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  /**
   * POR ONDE ESTA CONVERSA ENTROU — o mesmo rótulo da lista e da tela de
   * canais (#2383). `null` quando não há canal, e aí o badge não existe.
   */
  const rotuloCanal = rotuloDoCanalDaConversa(conversation.channel_sessions, t);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  // Marcar/desmarcar pessoal (spec 21, etapa 15 — botão no cabeçalho).
  //
  // GERENTE pode (spec decisão 1, D3): pessoal é decisão operacional — esconder
  // uma conversa da operação. Desbloquear exige ADMIN porque reabre um canal
  // que o cliente fechou (direito do titular, LGPD): dois gestos parecidos,
  // dois gates diferentes, cada um com seu motivo.
  //
  // Os hooks ficam AQUI, antes de qualquer early return (a ordem dos hooks não
  // pode mudar entre renderizações); com contato ausente o id vazio nunca
  // dispara porque o botão nem é desenhado.
  const ehPessoal = c?.is_personal === true;
  const podeMarcarPessoal =
    (user.is_platform_admin && !user.support) ||
    (activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  const marcarPessoal = useMarkPersonalContact(c?.id ?? "");
  const desmarcarPessoal = useUnmarkPersonalContact(c?.id ?? "");

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
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
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
    <div className={cn(
      "flex flex-col border-b border-border bg-background transition-all max-w-full overflow-hidden",
      recolhido ? "px-3 py-1.5 sm:px-4 sm:py-2" : "px-3 py-2 sm:px-4 sm:py-2.5"
    )}>
      {/* FAIXA DA CARTEIRA (#2591, regra 2): "este cliente pertence à carteira de
          A". `w-full` a põe numa linha própria acima da identidade, sem disputar
          espaço com a barra de ações — a faixa só existe quando o dono é OUTRA
          pessoa (o componente decide; sem carteira ele não desenha nada). */}
      {c?.id && (
        <FaixaDaCarteira contactId={c.id} quemAtendeId={conversation.assigned_to_user_id} />
      )}

      {/* LINHA SUPERIOR: Identidade do contato à esquerda e Botões Fixos de Controle à direita */}
      <div className="flex items-center justify-between gap-2 min-w-0 w-full">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <ChannelLogo channel={conversation.channel_sessions} size={20} />
            <h2 className="min-w-0 truncate text-sm font-semibold" title={displayName}>{displayName}</h2>
            <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
              {t(STATUS_LABEL[status] ?? status)}
            </Badge>
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
            {rotuloCanal && (
              <Badge
                variant="outline"
                className="h-4 min-w-0 max-w-[9rem] truncate px-1.5 text-[10px]"
                title={`${t("Entrou por")} ${rotuloCanal}`}
                data-testid="canal-da-conversa"
              >
                <span className="truncate">{rotuloCanal}</span>
              </Badge>
            )}
          </div>

          <div className="mt-1 flex items-center gap-2" data-testid="comando-da-conversa">
            {comando.quem === "humano" ? (
              <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} />
            ) : comando.quem === "automatico" ? (
              <OwnerBadge ownerKind="ai" ownerName={t("Automático")} />
            ) : (
              <OwnerBadge ownerKind={null} ownerName={null} />
            )}
            {phone && (
              <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
                <Phone size={11} weight="regular" aria-hidden /> {phone}
              </p>
            )}
          </div>
        </div>

        {/* CONTROLES FIXOS (Ocultar Ficha e Seta de Recolher) — SEMPRE visíveis e nunca empurrados para trás da ficha */}
        <div className="flex items-center gap-1 shrink-0 ml-2 z-10">
          {onToggleFicha && (
            <Button
              size="sm"
              variant={fichaRecolhida ? "default" : "outline"}
              className={cn(
                "h-8 gap-1.5 px-2 text-xs font-medium shrink-0 hidden xl:flex transition-colors",
                fichaRecolhida
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground border-border/80"
              )}
              onClick={onToggleFicha}
              title={fichaRecolhida ? t("Mostrar ficha do contato") : t("Ocultar ficha do contato")}
              aria-label={fichaRecolhida ? t("Mostrar ficha do contato") : t("Ocultar ficha do contato")}
            >
              <IdentificationCard size={16} />
              <span className="hidden 2xl:inline">{fichaRecolhida ? t("Ver ficha") : t("Ocultar ficha")}</span>
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md transition-colors"
            onClick={alternarRecolhido}
            title={recolhido ? t("Expandir ações do atendimento") : t("Recolher ações do atendimento")}
            aria-label={recolhido ? t("Expandir ações do atendimento") : t("Recolher ações do atendimento")}
            aria-expanded={!recolhido}
            data-testid="botao-recolher-cabecalho"
          >
            {recolhido ? (
              <CaretDown size={18} weight="bold" aria-hidden />
            ) : (
              <CaretUp size={18} weight="bold" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {/* BARRA DE AÇÕES DO ATENDIMENTO (expansível/recolhível) */}
      {!recolhido && (
        <div className="mt-2 pt-1.5 border-t border-border/40 flex flex-col gap-1 w-full min-w-0">
          <div className="flex min-w-0 flex-wrap sm:flex-nowrap items-center justify-between gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            {/* Etapa do Funil direta no cabeçalho */}
            <div className="shrink-0">
              <EtapaDoFunilHeader contactId={c?.id} />
            </div>

            {/* Ações operacionais */}
            <div className="flex items-center gap-1.5 shrink-0 flex-nowrap overflow-x-auto">
        {/* Primeira da barra e sem rótulo escrito: é ferramenta de LEITURA, não
            ação de atendimento, e não muda de lugar com o estado da conversa.
            Só o ícone porque a barra já quebrou a caixa útil em 1280px uma vez
            (ver o comentário do interruptor abaixo). */}
        {onBuscar && (
          <Button
            ref={botaoBuscaRef}
            size="sm"
            variant="ghost"
            className="w-11 px-0 lg:w-8"
            onClick={onBuscar}
            aria-label={t("Buscar nesta conversa")}
            title={t("Buscar nesta conversa")}
            aria-expanded={buscaAberta}
          >
            <MagnifyingGlass size={16} aria-hidden />
          </Button>
        )}
        {/* A chamada usa o telefone da ficha, mesmo quando o contato chegou por
            outro canal. Grupos não representam uma pessoa para ligar. */}
        {!conversation.is_group && c?.id && (
          <DialButton contactId={c.id} hasPhone={!!c.phone_number} />
        )}
        {/* Videochamada (#2440): sem JITSI_SERVER_URL este botão não renderiza,
            então ele não ocupa lugar nem na instalação que não oferece a feature.
            A sala é aleatória por chamada (#2441) — não depende de telefone,
            só do link ir pelo chat.

            `provider`/`lastInboundAt`, `bloqueio` e `encerrada` vêm para o
            botão seguir a MESMA régua do composer: janela de 24h (a rota não
            barra quem envia da tela — vira 131047 silencioso, #1614), a trava
            de contato e a de conversa encerrada. Os textos saem da mesma função
            do composer (lib/inbox/motivo-do-envio-bloqueado.ts); encerrada só
            desabilita, sem texto, como o composer faz. `supportReadonly` fica
            de fora: ele mora no `user`, que este componente não recebe. */}
        <VideoCallButton
          conversationId={conversation.id}
          provider={conversation.channel_sessions?.provider ?? null}
          lastInboundAt={conversation.last_inbound_at}
          bloqueio={motivoDoContato(c, t)}
          encerrada={status === "closed"}
        />
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
            onClick={() => setConfirmFecharOpen(true)}
          >
            {t("Fechar")}
          </Button>
        )}
        {encerrada && <Button size="sm" variant="outline" disabled={reopen.isPending}
          onClick={() => reopen.mutate({ conversation_id: conversation.id, expected_revision: conversation.service_revision })}>
          {t("Reabrir")}
        </Button>}
        {/* ARQUIVAR (#923): tira da frente sem destruir.
            A conversa já arquivada não mostra o botão — arquivar duas vezes não
            é um gesto que exista, e o botão só reapareceria como um clique que
            não muda nada. Fechada E resolvida mostram: são exatamente as que se
            quer mandar para o arquivo depois de encerradas, e é o caminho que
            faz a aba "Arquivadas" deixar de ser uma pasta morta.
            A permissão é a mesma de fechar (a rota `/conversations/[id]` é
            `requireSupportWrite`): quem pode encerrar, pode arquivar. */}
        {status !== "archived" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={arquivar.isPending}
            onClick={() => setConfirmArquivarOpen(true)}
          >
            {arquivar.isPending ? t("Arquivando...") : t("Arquivar")}
          </Button>
        )}
        {/* PESSOAL (spec 21, etapa 15): marcar tira a conversa do inbox na
            hora; desmarcar relista. O `data-testid` é contrato do e2e da
            spec (`contato-pessoal-sai-da-operacao.spec.ts`). */}
        {podeMarcarPessoal && c?.id && !ehPessoal && (
          <Button
            size="sm"
            variant="outline"
            disabled={marcarPessoal.isPending}
            data-testid="marcar-pessoal"
            title={t("Tira este contato da operação: a conversa sai do inbox.")}
            onClick={() => setConfirmPessoalOpen(true)}
          >
            {t("Marcar como pessoal")}
          </Button>
        )}
        {podeMarcarPessoal && c?.id && ehPessoal && (
          <Button
            size="sm"
            variant="outline"
            disabled={desmarcarPessoal.isPending}
            data-testid="desmarcar-pessoal"
            title={t("Devolve este contato à operação: a conversa volta ao inbox.")}
            onClick={() => desmarcarPessoal.mutate()}
          >
            {desmarcarPessoal.isPending ? t("Desmarcando...") : t("Desmarcar pessoal")}
          </Button>
        )}
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
          </div>
          {motivo !== null && (
            <Badge variant="outline" className="h-4 w-fit max-w-full truncate px-1.5 text-[10px]"
              title={t(ROTULO_DO_MOTIVO[motivo])} data-testid="badge-atendimento-humano">
              {t(ROTULO_DO_MOTIVO[motivo])}
            </Badge>
          )}
        </div>
      )}
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        numero={
          onAbrirConversa && c?.id
            ? {
                contactId: c.id,
                contactPhone: c.phone_number ?? null,
                channelSessionId: conversation.channel_session_id,
                onAbrirConversa,
              }
            : undefined
        }
      />
      <AlertDialog open={confirmFecharOpen} onOpenChange={setConfirmFecharOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Fechar esta conversa?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O atendimento é encerrado. Se o cliente escrever de novo, você pode reabrir.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                close.mutate({
                  conversation_id: conversation.id,
                  expected_revision: conversation.service_revision,
                })
              }
            >
              {t("Fechar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* A confirmação precisa dizer o que ACONTECE, e o que acontece depende
          do estado. `fn_conversation_set_status` trata `archived` como
          terminal: encerra o atendimento (grava `service_closed_at`,
          incrementa a revisão) e, com isso, desfaz a pausa do automático. Um
          atendente que leia "arquivar = tirar da vista, volto depois"
          encerraria o atendimento sem saber — e o robô voltaria a responder
          no próximo "oi" do cliente. Por isso a descrição só aparece quando
          `!encerrada`: quando já está encerrada, arquivar não muda o
          atendimento, só o lugar onde a conversa mora. */}
      <AlertDialog open={confirmArquivarOpen} onOpenChange={setConfirmArquivarOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Arquivar esta conversa?")}</AlertDialogTitle>
            {!encerrada && (
              <AlertDialogDescription>
                {t(
                  "Arquivar encerra este atendimento e guarda a conversa no histórico. Se o cliente escrever de novo, ela volta.",
                )}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                arquivar.mutate({
                  conversation_id: conversation.id,
                  expected_revision: conversation.service_revision,
                })
              }
            >
              {t("Arquivar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* A confirmação diz o que ACONTECE ao marcar: a conversa fecha e sai do
          atendente, e o contato fica inutilizado para envio — sem apagar nada.
          Desmarcar é direto no botão porque só relista o que já está lá. */}
      <AlertDialog open={confirmPessoalOpen} onOpenChange={setConfirmPessoalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Marcar este contato como pessoal?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A conversa sai do inbox e o contato fica fora da operação: sem IA, sem follow-up, sem campanha e sem envio. O histórico continua no banco e volta à vista ao desmarcar; follow-ups e campanhas cancelados não voltam.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => marcarPessoal.mutate()}>
              {t("Marcar como pessoal")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
