"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Robot } from "@/lib/ui/icons";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { comandoDaConversa, esperaDaConversa } from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Posição 1-based na fila (G5-03). Presente só na visão Fila. */
  queuePosition?: number;
  /**
   * Mostrar POR ONDE a conversa entrou.
   *
   * Só com mais de um número conectado. Com um só, o rótulo seria a mesma
   * palavra em toda linha da lista — ruído que ensina o olho a ignorar a área
   * onde vivem os avisos que importam (bloqueado, tags).
   */
  mostrarCanal?: boolean;
  /**
   * Mostrar QUEM está no comando de cada conversa.
   *
   * Mesma regra do canal, e pelo mesmo motivo: só quando o rótulo DISCRIMINA. Nas
   * abas "Fila" (todas sem dono), "Minhas" (todas do mesmo dono) e "IA" o badge
   * seria a mesma palavra em toda linha — ruído que ensina o olho a ignorar a
   * área onde vivem os avisos que importam. Quem decide é a lista, que é quem
   * sabe quantos donos distintos ela tem.
   */
  mostrarAtendente?: boolean;
  /**
   * Mostrar o ícone de robô na prévia da mensagem, quando quem manda é o
   * automático. Mesma regra dos dois badges acima: só quando DISCRIMINA. Na
   * aba "Automático" toda linha já é robô, e o ícone repetido em cada uma vira
   * ruído. Ausente ou `true` = mostra (comportamento anterior, seguro para o
   * teste que não passa esta prop).
   */
  mostrarAutomatico?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
}

/**
 * A COR SAI DE QUEM MANDA, NÃO DO STATUS.
 *
 * O mapa anterior era por `conversations.status`, e o `bg-purple-500` de
 * `ai_handling` era a mesma mentira das abas em forma de cor: `ai_handling` é
 * escrito por UM caminho só em produção, então a bolinha do automático quase
 * nunca aparecia — enquanto o robô atendia a maior parte da lista — e, quando
 * aparecia, sobrevivia ao silêncio, porque o status não muda quando o atendente
 * cala o automático.
 *
 * As chaves são as de `Comando["quem"]`, ao lado de `ROTULO_DO_COMANDO`, pela
 * mesma razão que ele mora ali: a cor e a palavra dizem a mesma coisa e não
 * podem ser mantidas em arquivos diferentes.
 */
const COR_DO_COMANDO: Record<string, string> = {
  humano: "bg-blue-500",
  automatico: "bg-purple-500",
  aguardando: "bg-amber-500",
  ninguem: "bg-muted-foreground/60",
  encerrada: "bg-muted-foreground/30",
};

function initials(name: string | null | undefined, fallback: string): string {
  const v = (name ?? "").trim();
  if (!v) return fallback.slice(0, 2).toUpperCase();
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

/**
 * "Aguardando há 5 min" — desde quando o cliente ESPERA.
 *
 * A régua é `esperaDaConversa`, a mesma `awaiting_since` que ordena a Fila
 * (#990): `last_inbound_at` é a ÚLTIMA mensagem do cliente, então a pílula de
 * quem insistia voltava para "há 1 min" a cada mensagem dele — o tempo na linha
 * contradizia a posição do lado e a ordem da lista. O fallback segue sendo a
 * criação, para a conversa que nunca recebeu mensagem.
 */
function waitingLabel(
  conversation: ConversationWithContact,
  t: (texto: string) => string = (texto) => texto, locale: Locale,
): string {
  const since = esperaDaConversa(conversation);
  if (!since) return t("Aguardando");
  return `${t("Aguardando")} ${formatDistanceToNowStrict(new Date(since), { addSuffix: true, locale: locale })}`;
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  queuePosition,
  mostrarCanal,
  mostrarAtendente,
  mostrarAutomatico = true,
  automaticoDaOrg,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || t("Sem mensagens");
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const naFila = queuePosition !== undefined;
  /**
   * A HORA DO CANTO RESPONDE À MESMA PERGUNTA QUE ORDENA A LISTA.
   *
   * Na Fila a lista sai por TEMPO DE ESPERA (`ORDEM_DA_ESPERA`: `awaiting_since`
   * crescente — a mensagem mais antiga sem resposta, #990), mas a hora do canto era
   * sempre a da última mensagem de QUALQUER lado. Bastava o atendente responder para o número daquela linha pular para
   * agora sem que a linha saísse do lugar: lida de cima para baixo, a coluna de
   * horas saía fora de ordem (#464 — "a lista parece aleatória") embaixo de uma
   * lista que estava certa.
   *
   * Fora da Fila a ordem é por atividade recente, e aí a última mensagem de
   * qualquer lado É a resposta certa — a régua do relógio segue a régua da lista.
   *
   * A origem é a MESMA da pílula "Aguardando há…" (`waitingLabel`), inclusive no
   * fallback: duas respostas para o mesmo "desde quando?" na mesma linha, a 40px
   * de distância, seriam a próxima divergência.
   */
  const horaDaOrdem = naFila
    ? esperaDaConversa(conversation)
    : conversation.last_message_at;
  const time = relativeTime(horaDaOrdem, localeDaData);
  const unread = conversation.unread_count_for_assignee ?? 0;


  /**
   * Quem manda, pela MESMA regra do cabeçalho.
   *
   * `status === 'ai_handling'` era um proxy ruim e foi medido: o único escritor
   * desse status em produção é o botão "Devolver ao automático", então o ícone de
   * robô aparecia só em conversa que já tinha sido escalada E devolvida — nunca
   * na que o automático atendeu do começo ao fim, que é a maioria.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  const dot = COR_DO_COMANDO[comando.quem] ?? COR_DO_COMANDO.ninguem;

  // O número DA EMPRESA por onde esta conversa chegou — não o do cliente. Com
  // dois canais é o que decide o tom da resposta e qual número a pessoa vê
  // respondendo. Cai no nome do canal quando não há número (canal recém-criado).
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = canal?.phone_number ?? canal?.display_name ?? null;

  const temSelos =
    visibleTags.length > 0 ||
    (mostrarAtendente && comando.quem === "humano") ||
    (mostrarCanal && rotuloCanal != null) ||
    Boolean(c?.is_blocked) ||
    Boolean(c?.is_anonymized);

  return (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      className={cn(
        "group relative flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated",
        "focus-visible:outline-hidden focus-visible:bg-surface-elevated",
        isSelected && "bg-accent-50 hover:bg-accent-50",
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      {isSelected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />
      )}
      <div className="relative shrink-0">
        <Avatar className="h-10 w-10">
          {/* Só monta a <img> quando existe arquivo: sem isso o browser pediria
              a rota para TODO contato da lista e levaria 404 em cada um sem
              foto — que é a maioria. O AvatarFallback do Radix já cobre o caso
              de a imagem não carregar, então as iniciais nunca somem. */}
          {c?.avatar_storage_path && !c?.is_anonymized ? (
            <AvatarImage
              src={`/api/v1/contacts/${c.id}/avatar`}
              alt=""
              className="object-cover"
            />
          ) : null}
          <AvatarFallback className="bg-surface-elevated text-xs font-medium text-text-muted">
            {initials(displayName, phoneFallback)}
          </AvatarFallback>
        </Avatar>
        <span
          className={cn(
            "absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full border-2 border-background",
            dot,
          )}
          aria-hidden
        />
        <ChannelLogo channel={canal} size={16} className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-background ring-2 ring-background" />
      </div>

      <div className="min-w-0 flex-1">
        {naFila && (
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-medium tabular-nums text-accent"
              aria-label={`${t("Posição")} ${queuePosition} ${t("na fila")}`}
            >
              {queuePosition}º
            </span>
            <span className="text-[11px] text-text-muted">
              {waitingLabel(conversation, t, localeDaData)}
            </span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm",
              unread > 0 ? "font-semibold text-text" : "font-medium text-text",
              c?.is_anonymized && "font-normal italic text-text-muted",
            )}
          >
            {displayName}
          </span>
          <span
            className="shrink-0 text-[11px] tabular-nums text-text-subtle"
            // O mesmo lugar da tela mostra duas coisas diferentes conforme a aba:
            // na Fila é "desde quando o cliente ESPERA" (a mensagem mais antiga sem
            // resposta — #990), nas outras é "há quanto tempo a conversa mexeu". O
            // rótulo existe só onde a leitura muda.
            title={naFila ? t("Desde quando o cliente espera resposta") : undefined}
          >
            {time}
          </span>
        </div>

        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              "min-w-0 truncate text-[13px]",
              unread > 0 ? "text-text" : "text-text-muted",
            )}
          >
            {isAi && mostrarAutomatico ? (
              <Robot size={12} weight="duotone" className="mr-1 inline align-[-2px]" aria-hidden />
            ) : null}
            {truncated}
          </p>
          {unread > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold tabular-nums text-accent-foreground">
              {unread}
            </span>
          )}
        </div>

        {temSelos && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {visibleTags.map((t) => (
              <ChipDeEtiqueta key={t} tag={t} className="h-4 px-1.5 text-[10px]" />
            ))}
            {overflow > 0 && (
              <span className="text-[10px] text-text-muted">+{overflow}</span>
            )}
            {mostrarAtendente && comando.quem === "humano" && (
              <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
            )}
            {mostrarCanal && rotuloCanal && (
              <Badge
                variant="outline"
                className="h-4 gap-1 px-1.5 text-[10px] font-normal text-text-muted"
                title={`${t("Entrou por")} ${rotuloCanal}`}
              >
                {rotuloCanal}
              </Badge>
            )}
            {c?.is_blocked && (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {t("Bloqueado")}
              </Badge>
            )}
            {c?.is_anonymized && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {t("Anonimizado")}
              </Badge>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
