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
import { CaretDown, CaretLeft, DotsThreeVertical, MagnifyingGlass, User } from "@/lib/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AvatarComCanal } from "@/components/inbox/AvatarComCanal";
import { useSnoozeConversation } from "@/hooks/inbox/useSnoozeConversation";
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
import { FaixaDaCarteira } from "@/components/inbox/FaixaDaCarteira";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { ParticipantesDaConversa } from "@/components/inbox/ParticipantesDaConversa";
import { DialButton } from "@/components/voice/DialButton";
import { VideoCallButton } from "@/components/inbox/VideoCallButton";
import { ReservarServicoNaConversa } from "@/components/agenda/ReservarServicoNaConversa";
import { motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
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
  /** Painel do contato (redesign kvgroup): o ícone de pessoa no fim da linha. */
  painelAberto?: boolean;
  onAlternarPainel?: () => void;
  /** Modo foco: com a lista oculta, o "‹ Lista" a traz de volta. */
  listaOculta?: boolean;
  onMostrarLista?: () => void;
}

/** O lembrete ainda vale? Mesma regra do `SnoozeButton`. */
function lembreteAtivo(snoozeUntil: string | null): boolean {
  return snoozeUntil != null && new Date(snoozeUntil).getTime() > Date.now();
}

/** As durações do "Lembrar" — as mesmas do `SnoozeButton`. */
const DURACOES_DO_LEMBRETE: Array<{ hours: 1 | 3 | 24; label: string }> = [
  { hours: 1, label: "Em 1 hora" },
  { hours: 3, label: "Em 3 horas" },
  { hours: 24, label: "Em 24 horas" },
];

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
  painelAberto = false,
  onAlternarPainel,
  listaOculta = false,
  onMostrarLista,
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
  // Pedidos de abertura vindos do menu ⋮ (cada incremento abre o diálogo).
  const [pedidoDeConvite, setPedidoDeConvite] = useState(0);
  const [pedidoDeReserva, setPedidoDeReserva] = useState(0);
  const { snooze, cancel: cancelarSnooze } = useSnoozeConversation();

  const c = conversation.contacts ?? null;
  const displayName = rotuloParaAEquipe(c, t);
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
  /**
   * ATENDIMENTO CONJUNTO (#2542): quem pode CONVIDAR é o dono da conversa ou um
   * gestor+ — exatamente o gate da rota. A tela não oferece o que a rota recusa:
   * um botão que devolve 403 é pior que um botão que não existe, porque a pessoa
   * descobre o limite depois de escolher o colega na lista. Não é gate de
   * SEGURANÇA (esse mora na rota, que revalida papel e organização): é o mesmo
   * desenho de `podeMarcarPessoal`, que também espelha a régua do servidor.
   */
  const podeConvidar =
    isMineAssigned ||
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
  const fatosDoComando = {
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
  };
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa(fatosDoComando);
  /**
   * O QUE "LIBERAR" FAZ DEPENDE DO ESTADO, e a guia do botão (#3003) não pode
   * prometer o automático de volta quando ele não volta.
   *
   * `fn_conversation_assign` com dono `null` deixa a conversa aberta e sem dono,
   * mas só limpa `bot_silenced_until` quando NÃO houve escalação
   * (`last_handoff_at is null`). Depois de uma escalação, com o contato travado
   * (`force_human`), descadastrado, em grupo ou numa org sem automático, a
   * conversa cai na fila esperando gente. A pergunta é a mesma regra de quem
   * manda, aplicada ao estado que a RPC vai gravar.
   */
  const liberarDevolveAoAutomatico =
    comandoDaConversa({
      ...fatosDoComando,
      status: "open",
      assigned_to_user_id: null,
      assigned_to_user_name: null,
      assignee_kind: null,
      bot_silenced_until: conversation.last_handoff_at ? fatosDoComando.bot_silenced_until : null,
    }).comando.quem === "automatico";

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
  /*
    A AÇÃO PRIMÁRIA (redesign kvgroup, seção 6.1): um botão de destaque só,
    que muda com o estado — Reabrir (encerrada), Assumir (sem dono ou ainda
    aberta) ou Fechar (atribuída). As demais ações não somem: vão para a seta
    do botão dividido (atendimento) ou para o menu ⋮ (raras).
  */
  const primaria: "reabrir" | "assumir" | "fechar" = encerrada ? "reabrir" : isOpen ? "assumir" : "fechar";
  const snoozeAtivo = lembreteAtivo(conversation.snooze_until ?? null);
  const podeReservar =
    !conversation.is_group && !!c?.id && !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const responsavel =
    comando.quem === "humano"
      ? `${t("Responsável")}: ${comando.nome ?? t("Atendente")}`
      : comando.quem === "automatico"
        ? t("Agente de IA atendendo")
        : t("Sem responsável");
  const botaoDeIcone =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-[var(--kv-hover)] hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
  const itemComDescricao = (titulo: string, descricao: string) => (
    <span className="flex flex-col">
      <span className="text-sm text-text">{titulo}</span>
      <span className="text-xs text-text-muted">{descricao}</span>
    </span>
  );

  return (
    <div className="border-b border-border bg-background">
      {/* FAIXA DA CARTEIRA (#2591, regra 2): só existe quando o dono da carteira
          é OUTRA pessoa — o componente decide; sem carteira não desenha nada. */}
      {c?.id && (
        <FaixaDaCarteira contactId={c.id} quemAtendeId={conversation.assigned_to_user_id} />
      )}
      <div className="flex min-h-[60px] items-center gap-3 px-3 py-2 max-md:flex-wrap md:px-4">
        {listaOculta && onMostrarLista && (
          <Button variant="ghost" size="sm" className="gap-1 px-2 max-md:hidden" onClick={onMostrarLista}>
            <CaretLeft size={14} aria-hidden />
            {t("Lista")}
          </Button>
        )}
        <AvatarComCanal
          contato={c}
          nome={displayName}
          reserva={phone ?? "??"}
          canal={conversation.channel_sessions}
          rotuloDoCanal={rotuloCanal}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-[15px] font-semibold" title={displayName}>
              {displayName}
            </h2>
            <span className="shrink-0 rounded-[5px] border border-border-strong bg-[var(--kv-surface-2)] px-1.5 text-[11px] leading-[18px] text-text-muted">
              {t(STATUS_LABEL[status] ?? status)}
            </span>
            {snoozeAtivo && (
              <span className="shrink-0 rounded-[5px] border border-border-strong bg-[var(--kv-surface-2)] px-1.5 text-[11px] leading-[18px] text-text-muted">
                {t("Lembrete")}
              </span>
            )}
            {/* "Dá para escrever agora?" se pergunta ANTES de digitar. */}
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
            {/* O testid é contrato: `escalacao-ciclo.spec.ts` o clica. */}
            {motivo !== null && (
              <Badge
                variant="outline"
                className="h-4 max-w-[12rem] shrink truncate px-1.5 text-[10px] max-lg:hidden"
                title={t(ROTULO_DO_MOTIVO[motivo])}
                data-testid="badge-atendimento-humano"
              >
                {t(ROTULO_DO_MOTIVO[motivo])}
              </Badge>
            )}
          </div>
          <p
            className="mt-0.5 truncate text-xs text-text-muted"
            data-testid="comando-da-conversa"
            title={[rotuloCanal, responsavel].filter(Boolean).join(" · ")}
          >
            {rotuloCanal && (
              <span data-testid="canal-da-conversa">{rotuloCanal}</span>
            )}
            {rotuloCanal && " · "}
            {responsavel}
          </p>
        </div>

        <div className="flex min-w-0 items-center gap-1 max-md:w-full max-md:overflow-x-auto max-md:pb-1 max-md:group-data-[teclado-aberto]/conversa:hidden [&>*]:shrink-0">
          {/* Quem mais atende junto (#2542) — os avatares ficam; o convite foi
              para o menu ⋮. */}
          <ParticipantesDaConversa
            conversationId={conversation.id}
            podeConvidar={podeConvidar}
            atendenteId={user.id}
            semBotaoDeConvidar
            pedidoDeConvite={pedidoDeConvite}
          />
          {onBuscar && (
            <button
              type="button"
              ref={botaoBuscaRef}
              className={cn(botaoDeIcone, buscaAberta && "bg-[var(--kv-surface-2)] text-text")}
              onClick={onBuscar}
              aria-label={t("Buscar nesta conversa")}
              title={t("Buscar nesta conversa")}
              aria-expanded={buscaAberta}
            >
              <MagnifyingGlass size={16} aria-hidden />
            </button>
          )}
          {/* Ligação e vídeo seguem as mesmas regras de antes; compactados. */}
          <div className="flex items-center gap-1 [&_button]:h-8 [&_button]:px-2 [&_button]:text-xs">
            {!conversation.is_group && c?.id && (
              <DialButton contactId={c.id} hasPhone={!!c.phone_number} />
            )}
            <VideoCallButton
              conversationId={conversation.id}
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
              bloqueio={motivoDoContato(c, t)}
              encerrada={status === "closed"}
            />
          </div>
          {podeReservar && c?.id && activeOrg && (
            <ReservarServicoNaConversa
              key={`${activeOrg.orgId}:${conversation.id}`}
              contactId={c.id}
              conversationId={conversation.id}
              contactName={displayName}
              semBotao
              pedidoDeAbertura={pedidoDeReserva}
            />
          )}

          {/* O BOTÃO DIVIDIDO: a ação primária + a seta com o resto do
              atendimento. Branco, 34px. */}
          <div className="flex h-[34px] items-stretch overflow-hidden rounded-[7px] bg-accent text-accent-foreground">
            {primaria === "reabrir" ? (
              <button
                type="button"
                disabled={reopen.isPending}
                title={t("Reabre o atendimento desta conversa, que estava encerrada.")}
                onClick={() =>
                  reopen.mutate(
                    { conversation_id: conversation.id, expected_revision: conversation.service_revision },
                    { onSuccess: () => toast.success(t("Conversa reaberta")) },
                  )
                }
                className="px-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {t("Reabrir")}
              </button>
            ) : primaria === "assumir" ? (
              <button
                type="button"
                disabled={claim.isPending}
                title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
                onClick={() =>
                  claim.mutate(
                    { conversation_id: conversation.id, expected_assignee: conversation.assigned_to_user_id },
                    { onSuccess: () => toast.success(t("Conversa atribuída a você")) },
                  )
                }
                className="px-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {t("Assumir")}
              </button>
            ) : (
              <button
                type="button"
                disabled={close.isPending}
                title={t("Encerra o atendimento. Depois você pode reabrir a conversa.")}
                onClick={() => setConfirmFecharOpen(true)}
                className="px-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {t("Fechar")}
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("Mais ações de atendimento")}
                  data-testid="acoes-do-atendimento"
                  className="flex w-7 items-center justify-center border-l border-[color-mix(in_srgb,var(--color-accent-fg)_20%,transparent)] transition-opacity hover:opacity-80"
                >
                  <CaretDown size={12} aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[260px]">
                {primaria === "assumir" && !encerrada && (
                  <DropdownMenuItem onSelect={() => setConfirmFecharOpen(true)} disabled={close.isPending}>
                    {itemComDescricao(t("Fechar"), t("Encerra o atendimento. Depois você pode reabrir a conversa."))}
                  </DropdownMenuItem>
                )}
                {!encerrada && (
                  <DropdownMenuItem onSelect={() => setReassignOpen(true)}>
                    {itemComDescricao(t("Transferir"), t("Passar para outro atendente ou fila"))}
                  </DropdownMenuItem>
                )}
                {!encerrada && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={snooze.isPending || cancelarSnooze.isPending}>
                      {itemComDescricao(
                        snoozeAtivo ? t("Lembrete ativo") : t("Lembrar"),
                        t("Some da lista e volta na data escolhida"),
                      )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {snoozeAtivo ? (
                        <DropdownMenuItem
                          onSelect={() => cancelarSnooze.mutate({ conversation_id: conversation.id })}
                        >
                          {t("Cancelar lembrete")}
                        </DropdownMenuItem>
                      ) : (
                        DURACOES_DO_LEMBRETE.map((d) => (
                          <DropdownMenuItem
                            key={d.hours}
                            onSelect={() =>
                              snooze.mutate({ conversation_id: conversation.id, duration_hours: d.hours })
                            }
                          >
                            {t(d.label)}
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {isMineAssigned && (
                  <DropdownMenuItem
                    disabled={release.isPending}
                    onSelect={() => release.mutate({ conversation_id: conversation.id })}
                  >
                    {itemComDescricao(
                      t("Devolver para a fila"),
                      liberarDevolveAoAutomatico
                        ? t("Solta esta conversa: ela fica sem dono e o atendimento automático volta a responder.")
                        : t("Remove você como responsável"),
                    )}
                  </DropdownMenuItem>
                )}
                {(podeDevolver || podePausar) && <DropdownMenuSeparator />}
                {podeDevolver && (
                  <DropdownMenuItem
                    disabled={retomar.isPending}
                    data-testid="devolver-ao-automatico"
                    onSelect={() => retomar.mutate({ conversation_id: conversation.id })}
                  >
                    {itemComDescricao(
                      t("Devolver ao automático"),
                      motivo === "contato_travado"
                        ? t("Religa o atendimento automático para este cliente — vale para todas as conversas dele.")
                        : t("Devolve esta conversa ao atendimento automático."),
                    )}
                  </DropdownMenuItem>
                )}
                {podePausar && (
                  <DropdownMenuItem
                    disabled={pausar.isPending}
                    data-testid="pausar-o-automatico"
                    onSelect={() => pausar.mutate({ conversation_id: conversation.id })}
                  >
                    {itemComDescricao(
                      t("Pausar o automático"),
                      t("O atendimento automático para nesta conversa. O dono não muda."),
                    )}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* ⋮ — ações raras. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t("Outras ações")} title={t("Outras ações")} className={botaoDeIcone}>
                <DotsThreeVertical size={18} weight="bold" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[220px]">
              {podeConvidar && (
                <DropdownMenuItem onSelect={() => setPedidoDeConvite((n) => n + 1)} data-testid="convidar-participante">
                  {t("Convidar participante")}
                </DropdownMenuItem>
              )}
              {podeReservar && (
                <DropdownMenuItem onSelect={() => setPedidoDeReserva((n) => n + 1)}>
                  {t("Reservar serviço")}
                </DropdownMenuItem>
              )}
              {podeMarcarPessoal && c?.id && !ehPessoal && (
                <DropdownMenuItem
                  disabled={marcarPessoal.isPending}
                  data-testid="marcar-pessoal"
                  onSelect={() => setConfirmPessoalOpen(true)}
                >
                  {t("Marcar como pessoal")}
                </DropdownMenuItem>
              )}
              {podeMarcarPessoal && c?.id && ehPessoal && (
                <DropdownMenuItem
                  disabled={desmarcarPessoal.isPending}
                  data-testid="desmarcar-pessoal"
                  onSelect={() => desmarcarPessoal.mutate()}
                >
                  {desmarcarPessoal.isPending ? t("Desmarcando...") : t("Desmarcar pessoal")}
                </DropdownMenuItem>
              )}
              {c?.id && (
                <DropdownMenuItem asChild>
                  <Link href={`/app/contacts/${c.id}`}>{t("Ver contato")}</Link>
                </DropdownMenuItem>
              )}
              {status !== "archived" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={arquivar.isPending}
                    onSelect={() => setConfirmArquivarOpen(true)}
                    className="text-[var(--kv-danger-text)] focus:text-[var(--kv-danger-text)]"
                  >
                    {arquivar.isPending ? t("Arquivando...") : t("Arquivar")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {onAlternarPainel && (
            <button
              type="button"
              onClick={onAlternarPainel}
              aria-label={painelAberto ? t("Fechar painel do contato") : t("Abrir painel do contato")}
              title={t("Painel do contato")}
              aria-pressed={painelAberto}
              className={cn(botaoDeIcone, "max-md:hidden", painelAberto && "bg-[var(--kv-surface-2)] text-text")}
            >
              <User size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>
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
