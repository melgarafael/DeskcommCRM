"use client";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, MagnifyingGlass } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import type { Role, VisibilityMode } from "@/lib/auth/types";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "archived" | "ai";

const INBOX_TABS: { value: InboxTab; label: string }[] = [
  { value: "unassigned", label: "Fila" },
  { value: "mine", label: "Minhas" },
  { value: "all", label: "Todas" },
  { value: "closed", label: "Fechadas" },
  // "Arquivadas" fica ao lado de "Fechadas" porque as duas são passado — e
  // separada dela porque são passados diferentes (#923): fechada é atendimento
  // encerrado, arquivada é o que saiu da fila de trabalho sem ser destruído.
  { value: "archived", label: "Arquivadas" },
  // "Automático", não "IA": a palavra deste ator já é contrato em quatro arquivos
  // e no dicionário, e `handoff-por-orcamento.test.ts` usa literalmente "Voltar
  // para a IA" como a sabotagem que deve reprovar. A aba era a última fora do
  // padrão — e ela mudou de significado junto (deixou de filtrar `ai_handling` e
  // passou a perguntar a régua do motor), então o rótulo velho descreveria outra
  // coisa.
  { value: "ai", label: "Automático" },
];

/**
 * Visões visíveis por papel + escopo (G4-02, acceptance 1). 'Todas' fica oculta
 * para `agent` quando visibility_mode ≠ 'all'; viewer/manager/admin sempre veem.
 * É apenas cosmético — a RLS (G4-01) é quem garante o escopo mesmo via ?filter=all.
 */
export function visibleInboxTabs(role: Role, mode: VisibilityMode | undefined): InboxTab[] {
  const hideAll = role === "agent" && mode !== "all";
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll)).map((t) => t.value);
}

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
  tag?: string;
}

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
}

export function InboxFilters({ value, onChange }: Props) {
  const t = useT();
  const [searchInput, setSearchInput] = useState(value.search);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [moreTabs, setMoreTabs] = useState({ left: false, right: false });
  const updateMoreTabs = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
    const next = { left: list.scrollLeft > 1, right: list.scrollLeft < maxScroll - 1 };
    setMoreTabs((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next,
    );
  }, []);
  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const centerSelectedTab = () => {
      // Deixar a aba só na borda esconde as vizinhas. Centralizar mostra o
      // contexto dos dois lados, salvo nas extremidades naturais da faixa.
      const selected = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (selected) {
        const selectedCenter =
          selected.getBoundingClientRect().left - list.getBoundingClientRect().left +
          list.scrollLeft + selected.offsetWidth / 2;
        const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
        list.scrollLeft = Math.max(0, Math.min(maxScroll, selectedCenter - list.clientWidth / 2));
      }
      updateMoreTabs();
    };
    centerSelectedTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(centerSelectedTab);
    observer.observe(list);
    list.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [value.tab, updateMoreTabs]);
  /**
   * O campo escuta o valor de FORA — e só ele.
   *
   * O estado do campo é próprio porque o debounce mora nele. O preço era não
   * saber quando o filtro morria por outro caminho: "Limpar filtros" zerava a
   * busca aplicada e deixava o termo escrito na tela, mostrando uma busca que
   * não valia mais — a mesma mentira de tela que esta entrega existe para matar.
   *
   * A ref guarda o que ESTE campo propagou. Valor de fora diferente dela = a
   * mudança veio de outro lugar, e o campo adota. Igual = foi o próprio campo, e
   * adotar atropelaria quem continuou digitando.
   *
   * ⚠️ O QUE O TESTE ALCANÇA, E O QUE NÃO. Tirar este efeito reprova o primeiro
   * caso de `tests/unit/limpar-filtros-limpa-o-campo.test.tsx` — medido. Já a
   * marca lá embaixo, no timer, NÃO é alcançada por teste determinístico: ela
   * defende a corrida entre o timer disparar e este efeito rodar, e nessa fresta
   * o teste nunca consegue digitar. Medido também: sabotá-la deixa os dois casos
   * verdes. Está escrito aqui em vez de fingir cobertura que não existe.
   */
  const propagado = useRef(value.search);
  useEffect(() => {
    if (value.search !== propagado.current) {
      propagado.current = value.search;
      setSearchInput(value.search);
    }
  }, [value.search]);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  const { activeOrg } = useAuth();
  /**
   * As opções são a UNIÃO das duas caixas — as mesmas que o filtro consulta
   * (`conversations.tags` ou `contacts.tags`, no handler da lista).
   *
   * Vinham só do vocabulário de CONVERSA: o marcador escrito no contato nem
   * aparecia para ser escolhido. Quem oferece e quem filtra lendo fontes
   * diferentes é o defeito espelhado — ou a opção existe e devolve vazio, ou o
   * marcador que funciona nunca é oferecido.
   */
  const orgId = activeOrg?.orgId ?? null;
  const { data: tagsDeConversa } = useConversationTagVocabulary(orgId);
  const { data: tagsDeContato } = useContactTagVocabulary(orgId);
  const tagVocabulary = useMemo(
    () =>
      tagsDeConversa == null && tagsDeContato == null
        ? undefined
        : [...new Set([...(tagsDeConversa ?? []), ...(tagsDeContato ?? [])])].sort((a, b) =>
            a.localeCompare(b),
          ),
    [tagsDeConversa, tagsDeContato],
  );
  // Os MESMOS filtros que a lista aplicou. Badge que conta o que a aba não mostra
  // manda o atendente procurar trabalho que não existe — a regra já estava escrita
  // na rota; faltava alcançar os filtros ao lado da aba.
  const { data: counts } = useConversationCounts(activeOrg?.orgId ?? null, {
    unread: value.onlyUnread,
    tag: value.tag,
    channel_session_id: value.channel_session_id,
  });

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((t) => t.value);
  const moveTab = (direction: -1 | 1) => {
    const next = tabs[tabs.indexOf(value.tab) + direction];
    if (next) onChange({ ...value, tab: next });
  };
  const countFor: Partial<Record<InboxTab, number>> = {
    // `fila` é o nome novo; `unassigned` é o alias que a rota versionada mantém.
    // O `??` cobre a janela em que a página ainda lê um cache de react-query
    // gravado antes do deploy — sem ele o badge sumiria por alguns segundos.
    unassigned: counts?.fila ?? counts?.unassigned,
    // A aba do automático ganhou contador junto com o significado: ela deixou de
    // filtrar `ai_handling` (2 conversas) e passou a mostrar o que o robô conduz
    // (47, na instalação onde isto foi medido). Um número que existe na API e não
    // aparece na tela é trabalho feito que ninguém vê.
    ai: counts?.automatico,
    mine: counts?.mine,
    all: counts?.all,
    closed: counts?.closed,
    archived: counts?.archived,
  };
  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox mostrando um subconjunto — às vezes vazio — sem nada na
  // tela dizendo que há filtro. O número some do dropdown junto com o canal, e o
  // alternador inteiro sumiria com ele se sobrasse menos de dois.
  const filtroForaDaLista =
    value.channel_session_id != null &&
    channels != null &&
    !channels.some((c) => c.id === value.channel_session_id);
  // Alternador só aparece com 2+ números — com um só não há o que alternar.
  const showChannelSwitch = (channels?.length ?? 0) >= 2 || filtroForaDaLista;
  /**
   * O SELETOR NÃO PODE SUMIR DEBAIXO DO MENU ABERTO.
   *
   * A condicional abaixo decide a EXISTÊNCIA do `<Select>`, e ela lê duas
   * queries em voo — as duas com `orgId` na chave e `enabled: !!orgId`. Um
   * único render em que o vocabulário volte a indefinido ou vazio (chave nova,
   * refetch, organização piscando) não escondia só o controle: DESMONTAVA o
   * Select, e o menu que o operador tinha acabado de abrir fechava sozinho, com
   * o gatilho de volta em "Todas as tags". Era o filtro fechando na cara de
   * quem ia escolher, e o `filtro-por-marcador-pela-tela.spec.ts` intermitente.
   *
   * Por isso o seletor passa a usar o último vocabulário NÃO-VAZIO que esta
   * tela conheceu: enquanto o de agora oscila, o de antes segura o controle
   * montado. O quadro nunca teve o defeito pelo mesmo motivo por outro caminho
   * — `components/kanban/FilterBar.tsx` mantém o gatilho montado e só o desliga
   * (`disabled`) sem opções. A lembrança faz o mesmo serviço sem estrear um
   * controle morto para a organização que ainda não tem etiqueta nenhuma: essa
   * continua sem o seletor, que é o que a condicional sempre quis dizer.
   *
   * Medido em `tests/unit/inbox-filtro-de-tag-nao-desmonta.test.tsx`.
   */
  const [ultimoVocabulario, setUltimoVocabulario] = useState<string[]>([]);
  if (tagVocabulary != null && tagVocabulary.length > 0 && tagVocabulary !== ultimoVocabulario) {
    // Ajuste de estado DURANTE a renderização (o padrão que a documentação do
    // React chama de "adjusting state when props change"): o React reinicia o
    // render deste componente com o valor novo antes de pintar, então o seletor
    // nunca chega à tela com o vocabulário velho. Efeito aqui não serviria —
    // ele roda DEPOIS da pintura, e a janela de um frame é exatamente a que
    // desmonta o Select.
    setUltimoVocabulario(tagVocabulary);
  }
  const vocabularioDoSeletor =
    tagVocabulary != null && tagVocabulary.length > 0 ? tagVocabulary : ultimoVocabulario;
  // O MESMO tratamento, agora para a etiqueta. Sem ele, o seletor inteiro some
  // com o filtro AINDA APLICADO — a lista fica num subconjunto, às vezes vazio,
  // e nada na tela diz que há filtro nem oferece como tirá-lo.
  // "Conhecido" e "não-vazio" são coisas diferentes, e é o primeiro que vale
  // aqui: a organização cuja ÚLTIMA etiqueta acabou de ser apagada responde
  // vocabulário vazio, e é justamente ela que precisa do seletor de volta para
  // desfazer o filtro que continua valendo.
  const vocabularioConhecido = tagVocabulary != null || ultimoVocabulario.length > 0;
  const tagForaDoVocabulario =
    value.tag != null &&
    vocabularioConhecido &&
    !vocabularioDoSeletor.includes(value.tag);
  const mostrarSeletorDeTag = vocabularioDoSeletor.length > 0 || tagForaDoVocabulario;

  // O timer lê o valor MAIS RECENTE, não o do render em que foi agendado.
  //
  // Antes, o efeito dependia só de `[searchInput]` e a closure capturava `value`
  // inteiro — `tab` incluso. Digitar e trocar de aba em menos de 250 ms fazia o
  // timer disparar com a aba VELHA e devolver o operador à aba anterior, sem ele
  // ter pedido. Some em teste manual: quem sabe do defeito digita devagar.
  //
  // As refs são o que permite manter `[searchInput]` como única dependência (pôr
  // `value`/`onChange` ali reagendaria o timer a cada render e a busca nunca
  // fecharia) SEM pagar o preço da closure velha.
  const valorRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // A atualização vai num efeito, e não no corpo do render: escrever em ref
  // durante a renderização é proibido pela regra `react-hooks/refs` — o React
  // pode renderizar sem efetivar, e aí a ref passa a apontar para um estado que
  // nunca chegou à tela. O efeito roda depois do commit, quando `value` é real.
  useEffect(() => {
    valorRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      const atual = valorRef.current;
      if (searchInput !== atual.search) {
        // Marca ANTES de propagar: se o efeito de sincronização rodar depois de
        // a pessoa ter digitado mais uma tecla, ele veria o valor que ESTE campo
        // acabou de mandar e o adotaria por cima do que já está na tela. Sem
        // teste que alcance — ver o aviso no efeito lá em cima.
        propagado.current = searchInput;
        onChangeRef.current({ ...atual, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  return (
    <div className="border-b border-border bg-background">
      <div className="space-y-2 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlass
              size={15}
              weight="regular"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
              aria-hidden
            />
            {/* "última mensagem", e não "mensagem": a busca alcança apenas
                `conversations.last_message_preview` — a ÚLTIMA mensagem, truncada em 200
                caracteres já na ingestão (`grep -rn 'slice(0, 200)' lib/channels/` mostra onde).
                Medido numa conversa real de 32 mensagens: buscar o que o cliente pediu na
                3ª devolve ZERO. Alcançar o histórico é projeto próprio (índice trigram +
                retenção + LGPD); até lá, a tela não promete o que o backend não faz. */}
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("Buscar por nome, telefone ou última mensagem…")}
              className="h-9 rounded-full border-transparent bg-surface-elevated pl-9 text-sm shadow-none focus-visible:border-border focus-visible:bg-background"
              aria-label={t("Buscar conversas")}
            />
          </div>
          {/* Botão pressionável em vez de Switch: o filtro vive na mesma linha
              da busca, e o Switch com rótulo pedia uma linha inteira só para
              si numa coluna de 280px. */}
          <button
            type="button"
            aria-pressed={value.onlyUnread}
            onClick={() => onChange({ ...value, onlyUnread: !value.onlyUnread })}
            className={cn(
              "h-9 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              value.onlyUnread
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border bg-transparent text-text-muted hover:bg-surface-elevated",
            )}
          >
            {t("Não lidos")}
          </button>
        </div>

        {(showChannelSwitch || mostrarSeletorDeTag) && (
          <div className="flex gap-2">
            {showChannelSwitch && (
              <Select
                value={value.channel_session_id ?? "all"}
                onValueChange={(v) =>
                  onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
                }
              >
                <SelectTrigger
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                    value.channel_session_id != null && "border-accent bg-accent-soft text-accent",
                  )}
                  aria-label={t("Filtrar por número de WhatsApp")}
                >
                  <SelectValue placeholder={t("Todos os números")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todos os números")}</SelectItem>
                  {filtroForaDaLista && value.channel_session_id != null && (
                    <SelectItem value={value.channel_session_id}>{t("Número removido")}</SelectItem>
                  )}
                  {channels?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {channelLabel(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {mostrarSeletorDeTag && (
              <Select
                value={value.tag ?? "all"}
                onValueChange={(v) => onChange({ ...value, tag: v === "all" ? undefined : v })}
              >
                <SelectTrigger
                  className={cn(
                    "h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
                    value.tag != null && "border-accent bg-accent-soft text-accent",
                  )}
                  aria-label={t("Filtrar por tag")}
                >
                  {/* O gatilho mostra o CHIP da etiqueta filtrada, e não o texto
                      cru: é a mesma cor que a lista mostra ao lado, e é o que
                      faz o filtro ativo se reconhecer de relance — mesma razão
                      do `border-accent` acima. Sem filtro, o texto continua
                      sendo o de sempre (`Todas as tags`). */}
                  <SelectValue placeholder={t("Todas as tags")}>
                    {value.tag ? (
                      <ChipDeEtiqueta tag={value.tag} className="h-5 px-1.5 text-[11px]" />
                    ) : (
                      t("Todas as tags")
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("Todas as tags")}</SelectItem>
                  {/* A órfã entra na lista: sem ela o Select mostraria o
                      placeholder no lugar do valor JÁ selecionado, e o operador
                      veria "Todas as tags" com um filtro ativo. */}
                  {[
                    ...vocabularioDoSeletor,
                    ...(tagForaDoVocabulario && value.tag ? [value.tag] : []),
                  ].map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {/* Ponto, não chip: a opção é uma linha de 280 px que já
                          divide espaço com o filtro de número. O nome continua
                          sendo o que se lê; a cor só acelera o reconhecimento
                          de quem já conhece o vocabulário da operação. */}
                      <span className="inline-flex items-center gap-2">
                        <PontoDaEtiqueta tag={tag} />
                        {tag}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {/* As setas aparecem só quando há abas fora da área visível; a faixa e o
          sublinhado continuam com a altura compacta do Inbox. */}
      <Tabs
        value={value.tab}
        onValueChange={(v) => onChange({ ...value, tab: v as InboxTab })}
        className="px-3"
      >
        <div className="flex items-center gap-1">
          {moreTabs.left ? (
            <button
              type="button"
              onClick={() => moveTab(-1)}
              aria-label={t("Aba anterior")}
              className="flex w-4 shrink-0 items-center justify-center text-text-muted hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CaretLeft size={13} aria-hidden />
            </button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
          <TabsList
            ref={tabsListRef}
            onScroll={updateMoreTabs}
            className="h-auto min-w-0 flex-1 justify-between gap-2 rounded-none bg-transparent p-0 [scrollbar-width:none]"
          >
            {tabs.map((tab) => {
              const meta = INBOX_TABS.find((t) => t.value === tab)!;
              const count = countFor[tab];
              return (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="shrink-0 gap-1 rounded-none border-b-2 border-transparent px-0 pb-2 pt-1 text-xs font-medium text-text-muted data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-text data-[state=active]:shadow-none"
                >
                  {t(meta.label)}
                  {typeof count === "number" && count > 0 && (
                    <span className="text-[11px] tabular-nums text-text-subtle">{count}</span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {moreTabs.right ? (
            <button
              type="button"
              onClick={() => moveTab(1)}
              aria-label={t("Próxima aba")}
              className="flex w-4 shrink-0 items-center justify-center text-text-muted hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CaretRight size={13} aria-hidden />
            </button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}
        </div>
      </Tabs>
    </div>
  );
}
