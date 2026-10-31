"use client";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDown, ChatCircle, Check, MagnifyingGlass, SidebarSimple, SlidersHorizontal } from "@/lib/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { StatusDaLista } from "@/lib/inbox/visao-do-inbox";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import {
  type ModoDeEtiqueta,
  marcadoresEscolhidos,
} from "@/lib/inbox/marcador-da-conversa";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { roleAtLeast, type Role, type VisibilityMode } from "@/lib/auth/types";
import { SeletorDeAtendente } from "@/components/inbox/SeletorDeAtendente";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "archived" | "ai" | "groups";

/**
 * A faixa na ORDEM DO TRABALHO (#2498): primeiro o que o robô conduz, depois o
 * que espera gente, depois o histórico. Antes "Automático" fechava a faixa,
 * depois de dois passados — o valor que o operador mais olha era o último.
 *
 * Só a ordem mudou: mesmos `value`, mesmos rótulos, mesmas permissões
 * (`visibleInboxTabs` filtra sem reordenar) e mesmas contagens (`countFor` lê
 * por chave, e a chave não acompanha a posição). `moveTab` anda pelo MESMO
 * array, então as setas continuam vizinha a vizinha.
 */
const INBOX_TABS: { value: InboxTab; label: string }[] = [
  // "Automático", não "IA": a palavra deste ator já é contrato em quatro arquivos
  // e no dicionário, e `handoff-por-orcamento.test.ts` usa literalmente "Voltar
  // para a IA" como a sabotagem que deve reprovar. O rótulo não mudou quando o
  // significado mudou (deixou de filtrar `ai_handling` e passou a perguntar a
  // régua do motor) — e a posição sim: ela era a última fora do padrão.
  { value: "ai", label: "Automático" },
  { value: "unassigned", label: "Fila" },
  { value: "mine", label: "Minhas" },
  { value: "all", label: "Todas" },
  { value: "closed", label: "Fechadas" },
  // "Arquivadas" fica ao lado de "Fechadas" porque as duas são passado — e
  // separada dela porque são passados diferentes (#923): fechada é atendimento
  // encerrado, arquivada é o que saiu da fila de trabalho sem ser destruído.
  { value: "archived", label: "Arquivadas" },
  { value: "groups", label: "Grupos" },
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
  /**
   * A etiqueta escolhida, ou VÁRIAS (#1274).
   *
   * `string` continua aceito e continua significando a MESMA coisa: é o que o
   * `InboxLayout`, o deep-link e qualquer chamada antiga produzem. Uma etiqueta
   * só nunca tem dois sentidos, porque o caminho singular da régua
   * (`aplicarMarcador`) é o mesmo de antes — byte a byte.
   */
  tag?: string | readonly string[];
  /** E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão. */
  tagMode?: ModoDeEtiqueta;
  /** A aba "Grupos" (Task 10): manda `is_group=true` na listagem. */
  onlyGroups?: boolean;
  /**
   * Só as conversas deste atendente (id do usuário). Filtro de GERENTE para cima;
   * ausente = todas. A aba Minhas já é "as minhas", então ali ele não vale.
   */
  assigned_to?: string;
}

/**
 * Trocar de aba, por QUALQUER caminho (clique na aba ou setas de "Aba anterior"/
 * "Próxima aba"). Minhas já é "só as minhas": um atendente escolhido antes não
 * vale ali, e seguir com ele deixaria as outras abas contando o atendente com o
 * seletor escondido.
 */
export function comAba(value: InboxFiltersValue, tab: InboxTab): InboxFiltersValue {
  return { ...value, tab, ...(tab === "mine" ? { assigned_to: undefined } : {}) };
}

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /** O status do seletor ao lado do título (redesign kvgroup). */
  status?: StatusDaLista;
  onStatusChange?: (status: StatusDaLista) => void;
  /** Abre o "Iniciar conversa" — ausente quando a pessoa não pode iniciar. */
  onIniciarConversa?: () => void;
  /** Modo foco: esconde a coluna da lista. */
  onOcultarLista?: () => void;
  /** Com conversas marcadas, a barra de ações em lote ocupa a linha do título. */
  barraDeLote?: ReactNode;
}

/** As três abas de DONO (redesign kvgroup), na ordem do documento. */
// "Grupos" (kvgroup): só as conversas de grupo, de qualquer dono.
const ABAS_DE_DONO: InboxTab[] = ["mine", "unassigned", "groups", "all"];

const STATUS_DA_LISTA: { value: StatusDaLista; label: string }[] = [
  { value: "abertas", label: "Abertas" },
  { value: "fechadas", label: "Fechadas" },
  { value: "arquivadas", label: "Arquivadas" },
];

export function InboxFilters({
  value,
  onChange,
  status = "abertas",
  onStatusChange,
  onIniciarConversa,
  onOcultarLista,
  barraDeLote,
}: Props) {
  const t = useT();
  const [searchInput, setSearchInput] = useState(value.search);

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
  // A lista de etiquetas escolhida, normalizada pelo MESMO caminho do servidor
  // (`marcadoresEscolhidos`): sem vazio, sem repetido, com a ordem da primeira
  // aparição. Duas fontes de verdade para "quantas etiquetas estão escolhidas"
  // fariam a tela mostrar um filtro e a lista aplicar outro.
  const etiquetas = useMemo(
    () => marcadoresEscolhidos(typeof value.tag === "string" ? [value.tag] : (value.tag ?? [])),
    [value.tag],
  );
  // Os MESMOS filtros que a lista aplicou. Badge que conta o que a aba não mostra
  // manda o atendente procurar trabalho que não existe — a regra já estava escrita
  // na rota; faltava alcançar os filtros ao lado da aba.
  const { data: counts } = useConversationCounts(activeOrg?.orgId ?? null, {
    assigned_to: value.assigned_to,
    unread: value.onlyUnread,
    tag: etiquetas,
    tagMode: value.tagMode,
    channel_session_id: value.channel_session_id,
  });

  // Filtro por ATENDENTE: só para gerente ou acima (a lista de quem atende é da
  // gestão; o atendente comum continua vendo só o escopo dele, que a RLS impõe).
  const podeFiltrarPorAtendente = roleAtLeast(activeOrg?.role, "manager");
  const mostrarSeletorDeAtendente = podeFiltrarPorAtendente && value.tab !== "mine";

  const visiveis = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((t) => t.value);
  const tabs = ABAS_DE_DONO.filter((aba) => visiveis.includes(aba));
  // "Todas" ABERTAS: o `all` da contagem é tudo o que a pessoa vê, encerradas
  // inclusive — o status agora é escolhido no seletor, então a aba desconta.
  const abertasTodas =
    counts?.all != null ? Math.max(0, counts.all - (counts.closed ?? 0) - (counts.archived ?? 0)) : undefined;
  const contagemDoStatus: Record<StatusDaLista, number | undefined> = {
    abertas: abertasTodas,
    fechadas: counts?.closed,
    arquivadas: counts?.archived,
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
    all: abertasTodas,
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
  // ⚠️ A VALIDAÇÃO DO FILTRO ÓRFÃO PASSOU A SER SOBRE A LISTA (#1274). Com uma
  // etiqueta só, "está no vocabulário" é uma pergunta; com VÁRIAS, é outra: basta
  // uma das escolhidas ter sumido do vocabulário para o operador precisar da
  // válvula. O sintoma sem isto seria o pior dos dois: um filtro de duas
  // etiquetas, uma delas apagada, e a tela sem dizer que há filtro nenhum.
  // ⚠️ `&&` AQUI DEVOLVERIA `false | string[]`, e `false.length` não existe. A
  // forma é um ternário que devolve SEMPRE lista: o resto do componente só
  // precisa do comprimento, e um `false` no meio obrigaria cada uso a checar.
  const etiquetasForaDoVocabulario =
    etiquetas.length > 0 && vocabularioConhecido
      ? etiquetas.filter((tag) => !vocabularioDoSeletor.includes(tag))
      : [];
  const mostrarSeletorDeTag =
    vocabularioDoSeletor.length > 0 || etiquetasForaDoVocabulario.length > 0;
  // O menu não fecha a cada clique: quem escolhe duas etiquetas não pode ter de
  // reabrir o menu entre a primeira e a segunda, e o `DropdownMenuCheckboxItem`
  // é o item que NÃO fecha (o `Select` de hoje fecha). A regra é do componente,
  // e por isso o gatilho é um botão com `aria-expanded` em vez de um `Select`.
  const opcoesDoSeletor = [
    ...vocabularioDoSeletor,
    ...etiquetasForaDoVocabulario,
  ];
  /**
   * A BUSCA DENTRO DO SELETOR (#2498) — e ela é de propósito SEM consulta.
   *
   * O vocabulário inteiro já está no navegador (as mesmas duas caixas que o
   * filtro consulta), então filtrar aqui custa um `filter` em memória. O que a
   * busca NÃO pode fazer é mexer em `value`: `tag`/`tagMode` são a CHAVE da
   * query de contagens e do pedido da lista, e cada tecla que os alterasse
   * mandaria uma ida ao servidor por caractere digitado — o oposto do que a
   * issue pede.
   *
   * O estado mora aqui e é ZERADO ao fechar o menu (`onOpenChange`): um termo
   * esquecido reabriria o seletor já filtrado, sem dizer que há filtro — a
   * mesma tela que mente que esta entrega existe para matar.
   */
  const [buscaDeEtiqueta, setBuscaDeEtiqueta] = useState("");
  const termoDaEtiqueta = buscaDeEtiqueta.trim().toLocaleLowerCase();
  const opcoesVisiveis = termoDaEtiqueta
    ? opcoesDoSeletor.filter((tag) => tag.toLocaleLowerCase().includes(termoDaEtiqueta))
    : opcoesDoSeletor;
  const alternaEtiqueta = (tag: string) => {
    const escolhida = etiquetas.includes(tag);
    const proximas = escolhida ? etiquetas.filter((t) => t !== tag) : [...etiquetas, tag];
    onChange({
      ...value,
      tag: proximas.length === 0 ? undefined : proximas,
      // O `modo` só faz sentido com DUAS: ao voltar para uma etiqueta só, ele
      // sai, porque `?tag=vip&modo=ou` é um link que não significa nada e
      // polui a URL (e a chave de cache do react-query) à toa.
      tagMode: proximas.length > 1 ? value.tagMode : undefined,
    });
  };

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

  /**
   * O CABEÇALHO DA LISTA (redesign kvgroup, seção 5): título + status numa
   * linha, a busca, e as três abas de DONO. O que não virou navegação — número,
   * etiquetas (com o E/OU) e atendente — mora no popover de filtros avançados,
   * com os MESMOS controles de antes. "Não lidos", "Grupos", os números e as
   * etiquetas também são visões do submenu do Inbox na barra lateral.
   */
  const temFiltroAvancado =
    value.channel_session_id != null || etiquetas.length > 0 || value.assigned_to != null;
  const rotuloDoStatus = STATUS_DA_LISTA.find((opcao) => opcao.value === status)?.label ?? "Abertas";
  // As contagens por aba são das ABERTAS; nos outros status a rota não as tem.
  const contagemNasAbas = status === "abertas";
  const botaoDeIcone =
    "relative flex h-[30px] w-[30px] items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-[var(--kv-hover)] hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="border-b border-border">
      {barraDeLote ?? (
        <div className="flex h-12 items-center gap-2 px-3">
          <h1 className="text-[17px] font-semibold text-text">{t("Inbox")}</h1>
          {onStatusChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="seletor-de-status"
                  aria-label={`${t("Status")}: ${t(rotuloDoStatus)}`}
                  className="flex h-6 items-center gap-1 rounded-[6px] border border-border-strong bg-[var(--kv-surface)] px-2 text-xs text-text-muted transition-colors hover:text-text"
                >
                  {t(rotuloDoStatus)}
                  <CaretDown size={10} aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {STATUS_DA_LISTA.map((opcao) => {
                  const total = contagemDoStatus[opcao.value];
                  return (
                    <DropdownMenuItem
                      key={opcao.value}
                      onSelect={() => onStatusChange(opcao.value)}
                      className="flex items-center gap-2"
                      data-testid={`status-${opcao.value}`}
                    >
                      <Check
                        size={14}
                        aria-hidden
                        className={cn(opcao.value !== status && "invisible")}
                      />
                      <span className="flex-1">{t(opcao.label)}</span>
                      {typeof total === "number" && (
                        <span className="text-[11px] tabular-nums text-text-subtle">{total}</span>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t("Filtros avançados")}
                  title={t("Filtros avançados")}
                  data-testid="filtros-avancados"
                  className={botaoDeIcone}
                >
                  <SlidersHorizontal size={16} aria-hidden />
                  {temFiltroAvancado && (
                    <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-text" />
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-2.5 p-3">
                <p className="text-xs font-semibold text-text">{t("Filtros avançados")}</p>
                {showChannelSwitch && (
                  <Select
                    value={value.channel_session_id ?? "all"}
                    onValueChange={(v) =>
                      onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
                    }
                  >
                    <SelectTrigger
                      className={cn(
                        "h-8 w-full rounded-[7px] text-xs shadow-none",
                        value.channel_session_id != null && "border-accent",
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
                  <DropdownMenu
                    onOpenChange={(aberto) => {
                      if (!aberto) setBuscaDeEtiqueta("");
                    }}
                  >
                    {/* Multi-seleção com `DropdownMenuCheckboxItem` (#1274): marca
                        e não fecha. Mesmo `aria-label` de antes. */}
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "flex h-8 w-full items-center truncate rounded-[7px] border border-border bg-transparent px-3 text-left text-xs",
                          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                          etiquetas.length > 0 && "border-accent",
                        )}
                        aria-label={t("Filtrar por tag")}
                      >
                        {etiquetas.length > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <ChipDeEtiqueta tag={etiquetas[0]!} className="h-5 px-1.5 text-[11px]" />
                            {etiquetas.length > 1 && (
                              <span className="tabular-nums text-[11px]">+{etiquetas.length - 1}</span>
                            )}
                          </span>
                        ) : (
                          t("Todas as tags")
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      <DropdownMenuLabel>{t("Todas as tags")}</DropdownMenuLabel>
                      <div className="px-2 pb-1">
                        <Input
                          value={buscaDeEtiqueta}
                          onChange={(e) => setBuscaDeEtiqueta(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key.length === 1) e.stopPropagation();
                          }}
                          placeholder={t("Buscar etiqueta")}
                          aria-label={t("Buscar etiqueta")}
                          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs shadow-none focus-visible:border-border"
                        />
                      </div>
                      <DropdownMenuItem
                        onClick={() => onChange({ ...value, tag: undefined, tagMode: undefined })}
                      >
                        {t("Todas as tags")}
                      </DropdownMenuItem>
                      {etiquetas.length > 1 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuRadioGroup
                            value={value.tagMode === "ou" ? "ou" : "e"}
                            onValueChange={(modo) =>
                              onChange({ ...value, tagMode: modo === "ou" ? "ou" : undefined })
                            }
                          >
                            <DropdownMenuRadioItem value="e">{t("Todas (E)")}</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="ou">
                              {t("Qualquer uma (OU)")}
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </>
                      )}
                      <DropdownMenuSeparator />
                      {opcoesVisiveis.map((tag) => (
                        <DropdownMenuCheckboxItem
                          key={tag}
                          checked={etiquetas.includes(tag)}
                          onCheckedChange={() => alternaEtiqueta(tag)}
                          onSelect={(e) => e.preventDefault()}
                        >
                          <span className="inline-flex items-center gap-2">
                            <PontoDaEtiqueta tag={tag} />
                            {tag}
                          </span>
                        </DropdownMenuCheckboxItem>
                      ))}
                      {termoDaEtiqueta !== "" && opcoesVisiveis.length === 0 && (
                        <p className="px-2 py-1.5 text-xs text-text-subtle">
                          {t("Nenhuma etiqueta com esse texto")}
                        </p>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {mostrarSeletorDeAtendente && (
                  <SeletorDeAtendente
                    value={value.assigned_to}
                    onChange={(atendente) => onChange({ ...value, assigned_to: atendente })}
                  />
                )}
                {!showChannelSwitch && !mostrarSeletorDeTag && !mostrarSeletorDeAtendente && (
                  <p className="text-xs text-text-muted">{t("Nenhum filtro extra disponível aqui.")}</p>
                )}
              </PopoverContent>
            </Popover>
            {onIniciarConversa && (
              <button
                type="button"
                onClick={onIniciarConversa}
                aria-label={t("Iniciar conversa")}
                title={t("Iniciar conversa")}
                className={botaoDeIcone}
              >
                <ChatCircle size={16} aria-hidden />
              </button>
            )}
            {onOcultarLista && (
              <button
                type="button"
                onClick={onOcultarLista}
                aria-label={t("Ocultar lista")}
                title={t("Ocultar lista")}
                className={cn(botaoDeIcone, "max-md:hidden")}
              >
                <SidebarSimple size={16} aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="px-3 pb-2">
        <div className="relative">
          <MagnifyingGlass
            size={15}
            weight="regular"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle"
            aria-hidden
          />
          {/* "última mensagem": a busca alcança `last_message_preview`, não o
              histórico inteiro — a tela não promete o que o backend não faz. */}
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("Buscar por nome, telefone ou última mensagem…")}
            className="h-[34px] rounded-[7px] border-border-strong bg-[var(--kv-surface)] pl-8 text-[13px] shadow-none"
            aria-label={t("Buscar conversas")}
          />
        </div>
      </div>

      {/* Três abas de DONO. Na visão "Com agente de IA" nenhuma fica ativa —
          escolher uma sai da visão. */}
      <Tabs value={value.tab} onValueChange={(v) => onChange(comAba(value, v as InboxTab))} className="px-3">
        <TabsList className="h-auto justify-start gap-4 rounded-none bg-transparent p-0">
          {tabs.map((tab) => {
            const meta = INBOX_TABS.find((x) => x.value === tab)!;
            const count = contagemNasAbas ? countFor[tab] : undefined;
            return (
              <TabsTrigger
                key={tab}
                value={tab}
                className="shrink-0 gap-1.5 rounded-none border-b-2 border-transparent px-0 pt-1 pb-2 text-[13px] font-medium text-text-muted data-[state=active]:border-[var(--kv-primary-bg)] data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-text data-[state=active]:shadow-none"
              >
                {t(meta.label)}
                {typeof count === "number" && count > 0 && (
                  <span className="rounded-full bg-[var(--kv-surface-2)] px-1.5 text-[11px] tabular-nums text-text-muted">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </div>
  );
}
