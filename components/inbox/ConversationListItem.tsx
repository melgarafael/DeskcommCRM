"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Check, Robot, Sparkle } from "@/lib/ui/icons";
import { AvatarComCanal } from "@/components/inbox/AvatarComCanal";
import { Badge } from "@/components/ui/badge";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import {
  comandoDaConversa,
  esperaDaConversa,
  ROTULO_DO_COMANDO,
  STATUS_ENCERRADOS,
} from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";

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
  /**
   * Marca esta linha no lote (#2484, F1). Presente só quando a seleção
   * múltipla está ligada — sem ela a caixa não aparece, e a lista continua
   * sendo o que era.
   */
  selecionado?: boolean;
  /**
   * Liga o modo de seleção: com esta prop a linha ganha a caixa de marcação.
   * A ação da caixa é SEPARADA do clique na linha — quem marca não abre a
   * conversa, e quem abre não marca.
   */
  onAlternarSelecao?: (id: string) => void;
  /**
   * Marca (ou desmarca) ESTA conversa como exemplo para o agente aprender
   * (#3006). Presente = a linha monta o controle; AUSENTE = a linha é
   * exatamente a que era, sem controle nenhum e sem selo — é o que mantém os
   * testes que renderizam a linha sozinha, e a lista que não oferece a ação.
   *
   * A CHAMADA À ROTA NÃO MORA AQUI, e isso é de propósito. Vem por prop, como
   * o `automaticoDaOrg`: uma resposta por lista, não por linha — e, medido, a
   * linha é renderizada sem `QueryClientProvider` em vários testes do repo, o
   * que faria um `useQueryClient()` aqui dentro derrubar todos eles com "No
   * QueryClient set". Quem faz o `POST .../usable-for-rag` é a lista.
   */
  onAlternarExemplo?: (id: string, enabled: boolean) => void;
  /** Há conversa marcada na lista: as caixas ficam visíveis em todos os itens. */
  emSelecao?: boolean;
  /** Quem está logado — para dizer "Atribuída a você". */
  usuarioAtualId?: string;
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
  mostrarAutomatico = true,
  automaticoDaOrg,
  selecionado = false,
  onAlternarSelecao,
  onAlternarExemplo,
  emSelecao = false,
  usuarioAtualId,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloParaAEquipe(c, t);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const hiddenTags = tags.slice(2);
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
    is_group: conversation.is_group ?? false,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  const dot = COR_DO_COMANDO[comando.quem] ?? COR_DO_COMANDO.ninguem;
  // A cor sozinha não se explica: quem não decorou a tabela perguntava o que
  // cada bolinha queria dizer. A palavra é a de ROTULO_DO_COMANDO, o rótulo que
  // o produto já define para cada estado, no passar do mouse e no leitor de
  // tela — antes ela era `aria-hidden`.
  //
  // Encerrada vence `humano` só na PALAVRA. Fechar não solta o dono
  // (`fn_service_status`), e `comandoDaConversa` segue dizendo `humano` para
  // nomear quem atendeu — a cor acompanha isso e fica como estava. Mas escrever
  // "Em atendimento" numa conversa fechada afirmaria no presente um atendimento
  // que acabou.
  const rotuloDoComando = t(
    STATUS_ENCERRADOS.has(conversation.status)
      ? ROTULO_DO_COMANDO.encerrada
      : (ROTULO_DO_COMANDO[comando.quem] ?? ROTULO_DO_COMANDO.ninguem),
  );

  // QUEM MANDA ESTA CONVERSA — o número DA EMPRESA por onde ela chegou, não o
  // do cliente. Com dois canais é o que decide o tom da resposta e qual número
  // a pessoa vê respondendo.
  //
  // #2383: quando o canal tem nome ou número, o texto é o MESMO do card da tela
  // de canais (`/app/connections`), com o nome amigável na frente — antes o
  // número vencia o nome, e um canal chamado "Peças" saía na lista como o
  // número cru. Sem canal associado (grupo, conversa sem sessão, não-WA) e sem
  // nome E sem número o badge continua não existindo, como estava.
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = rotuloDoCanalDaConversa(canal, t);

  /**
   * A CONVERSA MARCADA COMO EXEMPLO PARA O AGENTE (#3006).
   *
   * `usable_for_rag` é a coluna que a rota `usable-for-rag` liga; quem a traz
   * para cá é o `SELECT_COLS` da lista. Os dois rótulos são literais `t()`
   * separados — a cerca de espanhol cobra chave por chave, e uma escolha
   * ternária dentro do `t()` ficaria invisível para ela.
   */
  const exemploMarcado = Boolean(conversation.usable_for_rag);
  const rotuloExemplo = exemploMarcado
    ? t("Deixar de usar como exemplo")
    : t("Usar como exemplo para a IA");

  /*
    O ITEM DA LISTA (redesign kvgroup, seção 5.5): três linhas em ~72px —
    nome e hora; prévia e não lidas; e os metadados (fila, dono, IA). O que
    não coube na linha fixa não sumiu: etiquetas, exemplo da IA, bloqueado e
    anonimizado seguem em selos pequenos ao lado dos metadados; o número do
    canal foi para a bolinha do avatar (title). A caixa de seleção aparece
    sobre o avatar no hover — e em todos os itens quando há seleção.
  */
  const algumSelecionado = onAlternarSelecao !== undefined && emSelecao;
  const metadados = naFila
    ? `${queuePosition}º ${t("na fila")} · ${waitingLabel(conversation, t, localeDaData).toLocaleLowerCase()}`
    : STATUS_ENCERRADOS.has(conversation.status)
      ? rotuloDoComando
      : comando.quem === "humano"
        ? conversation.assigned_to_user_id === usuarioAtualId
          ? t("Atribuída a você")
          : `${t("Atribuída a")} ${comando.nome ?? t("Atendente")}`
        : isAi
          ? t("Agente de IA atendendo")
          : rotuloDoComando;

  return (
    <div className={cn("group/item relative mx-1.5 my-[1px] rounded-[8px]", selecionado && "bg-accent-soft")}>
      <button
        type="button"
        data-conversation-id={conversation.id}
        onClick={() => onSelect(conversation.id)}
        className={cn(
          "relative flex w-full min-w-0 items-start gap-3 rounded-[8px] px-2.5 py-3 text-left transition-colors",
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isSelected
            ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
            : !selecionado && "hover:bg-[color-mix(in_srgb,var(--color-text)_4%,transparent)]",
        )}
        aria-current={isSelected ? "true" : undefined}
      >
        <span className="relative shrink-0">
          <AvatarComCanal
            contato={c}
            nome={displayName}
            reserva={phoneFallback}
            canal={canal}
            rotuloDoCanal={rotuloCanal}
          />
          {/* Quem manda, no canto oposto ao canal (mesma cor de antes). */}
          <span
            className={cn("absolute -top-0.5 -left-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-bg)]", dot)}
            role="img"
            aria-label={rotuloDoComando}
            title={rotuloDoComando}
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-sm",
                  unread > 0 ? "font-bold text-text" : "font-medium text-text",
                  c?.is_anonymized && "font-normal italic text-text-muted",
                )}
              >
                {displayName}
              </span>
              {conversation.is_group && (
                <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                  {t("Grupo")}
                </Badge>
              )}
            </span>
            <span
              className="shrink-0 text-[11px] tabular-nums text-[var(--kv-text-faint)]"
              title={naFila ? t("Desde quando o cliente espera resposta") : undefined}
            >
              {time}
            </span>
          </span>

          <span className="mt-0.5 flex items-center justify-between gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-[13px]",
                unread > 0 || isSelected ? "text-text" : "text-text-muted",
              )}
            >
              {isAi && mostrarAutomatico ? (
                <Robot size={12} weight="duotone" className="mr-1 inline align-[-2px]" aria-hidden />
              ) : null}
              {truncated}
            </span>
            {unread > 0 && (
              <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold tabular-nums text-accent-foreground">
                {unread}
              </span>
            )}
          </span>

          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--kv-text-faint)]">
            <span className="min-w-0 truncate">
              {metadados}
              {mostrarCanal && rotuloCanal ? ` · ${rotuloCanal}` : ""}
            </span>
            {exemploMarcado && (
              <Sparkle
                size={11}
                weight="fill"
                className="shrink-0 text-accent"
                aria-label={t("Exemplo para a IA")}
                data-testid="selo-exemplo-ia"
              />
            )}
            {visibleTags.map((tag) => (
              <ChipDeEtiqueta key={tag} tag={tag} className="h-4 shrink-0 px-1.5 text-[10px]" />
            ))}
            {overflow > 0 && (
              <span className="shrink-0" title={hiddenTags.join(", ")}>+{overflow}</span>
            )}
            {c?.is_blocked && (
              <Badge variant="destructive" className="h-4 shrink-0 px-1.5 text-[10px]">
                {t("Bloqueado")}
              </Badge>
            )}
            {c?.is_anonymized && (
              <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]">
                {t("Anonimizado")}
              </Badge>
            )}
          </span>
        </span>
      </button>

      {/*
        A CAIXA DE SELEÇÃO (#2484) — fora do botão da linha (controle dentro de
        `<button>` é HTML inválido, e marcar não abre a conversa). Fica POR CIMA
        do avatar: some até o hover, o foco ou haver seleção em curso.
      */}
      {onAlternarSelecao && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selecionado}
          aria-label={t("Selecionar conversa")}
          title={t("Selecionar conversa")}
          data-testid={`selecao-em-lote-${conversation.id}`}
          onClick={() => onAlternarSelecao(conversation.id)}
          className={cn(
            "absolute top-[12px] left-[10px] flex h-9 w-9 items-center justify-center rounded-full transition-opacity",
            "focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            selecionado
              ? "bg-accent text-accent-foreground opacity-100"
              : cn(
                  "bg-[var(--kv-surface-2)] text-text-muted",
                  algumSelecionado ? "opacity-100" : "opacity-0 group-hover/item:opacity-100",
                ),
          )}
        >
          <span
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-[4px] border",
              selecionado ? "border-transparent" : "border-text-muted",
            )}
          >
            {selecionado && <Check size={12} weight="bold" aria-hidden />}
          </span>
        </button>
      )}

      {/*
        "EXEMPLO PARA A IA" (#3006): o ✨ saiu da linha fixa — aparece no hover,
        e sempre quando a conversa já é exemplo (o selo também está nos
        metadados). Fora do botão da linha, como a caixa de seleção.
      */}
      {onAlternarExemplo && (
        <button
          type="button"
          data-testid={`exemplo-ia-${conversation.id}`}
          aria-pressed={exemploMarcado}
          aria-label={rotuloExemplo}
          title={rotuloExemplo}
          onClick={() => onAlternarExemplo(conversation.id, !exemploMarcado)}
          className={cn(
            "absolute right-3 bottom-2 flex h-6 w-6 items-center justify-center rounded-[5px] transition-opacity",
            "focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            "bg-[var(--kv-surface-2)] opacity-0 group-hover/item:opacity-100",
            exemploMarcado ? "text-accent" : "text-text-muted hover:text-text",
          )}
        >
          <Sparkle size={13} weight={exemploMarcado ? "fill" : "regular"} aria-hidden />
        </button>
      )}
    </div>
  );
}
