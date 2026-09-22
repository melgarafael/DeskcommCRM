"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Phone, Robot } from "@/lib/ui/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { WA } from "@/components/inbox/whatsapp-theme";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
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

/** "Aguardando há 5 min" — desde a última mensagem do cliente (fallback: criação). */
function waitingLabel(
  conversation: ConversationWithContact,
  t: (texto: string) => string = (texto) => texto,
  locale: Locale,
): string {
  const since = conversation.last_inbound_at ?? conversation.created_at;
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
  automaticoDaOrg,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || t("Sem mensagens");
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const time = relativeTime(conversation.last_message_at, localeDaData);
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

  return (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-border bg-white px-3 py-3 text-left transition-colors",
        WA.hover,
        isSelected && WA.selected,
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      <div className="relative shrink-0">
        <Avatar className="h-10 w-10">
          {/* Só monta a <img> quando existe arquivo: sem isso o browser pediria
              a rota para TODO contato da lista e levaria 404 em cada um sem
              foto — que é a maioria. O AvatarFallback do Radix já cobre o caso
              de a imagem não carregar, então as iniciais nunca somem. */}
          {c?.avatar_storage_path && !c?.is_anonymized ? (
            <AvatarImage src={`/api/v1/contacts/${c.id}/avatar`} alt="" className="object-cover" />
          ) : null}
          <AvatarFallback className="text-xs">
            {initials(displayName, phoneFallback)}
          </AvatarFallback>
        </Avatar>
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-background",
            dot,
          )}
          aria-hidden
        />
      </div>

      <div className="min-w-0 flex-1">
        {queuePosition !== undefined && (
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-medium text-primary tabular-nums"
              aria-label={`${t("Posição")} ${queuePosition} ${t("na fila")}`}
            >
              {queuePosition}º
            </span>
            <span className="text-[10px] text-muted-foreground">
              {waitingLabel(conversation, t, localeDaData)}
            </span>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm font-medium",
              c?.is_anonymized && "text-muted-foreground italic",
            )}
          >
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
            {time}
          </span>
        </div>

        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {isAi ? <Robot size={10} weight="duotone" className="mr-1 inline" aria-hidden /> : null}
          {truncated}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {visibleTags.map((t) => (
            <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
              {t}
            </Badge>
          ))}
          {overflow > 0 && <span className="text-[10px] text-muted-foreground">+{overflow}</span>}
          {mostrarAtendente && comando.quem === "humano" && (
            <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
          )}
          {mostrarCanal && rotuloCanal && (
            <Badge
              variant="outline"
              className="h-4 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground"
              title={`${t("Entrou por")} ${rotuloCanal}`}
            >
              <Phone size={9} weight="regular" aria-hidden />
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
          {unread > 0 && (
            <Badge className={`ml-auto h-4 min-w-4 px-1.5 text-[10px] ${WA.unread}`}>
              {unread}
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}
