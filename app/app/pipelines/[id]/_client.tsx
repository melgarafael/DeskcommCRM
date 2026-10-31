"use client";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { useBoard } from "@/hooks/kanban/useBoard";
import { useDensidadeDoQuadro } from "@/hooks/kanban/useDensidadeDoQuadro";

function formatError(err: unknown, t: (texto: string) => string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return t("Erro desconhecido");
    }
  }
  return String(err);
}
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { CalendarioDoFunil } from "@/components/kanban/CalendarioDoFunil";
import { ListaDoFunil } from "@/components/kanban/ListaDoFunil";
import { FilterBar } from "@/components/kanban/FilterBar";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "@/lib/ui/icons";
import type { LeadFilters } from "@/lib/kanban/filters";
import { applyFilters, filtersFromParams, filtersToParams } from "@/lib/kanban/filters";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import { categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { cn } from "@/lib/utils";

/**
 * AS TRÊS VISÕES DO FUNIL (#2770, #3172).
 *
 * Quadro é o padrão — é o que todo mundo já conhece, e a aba nova não pode
 * sequestrar a tela de quem só quer mover card.
 */
type Visao = "quadro" | "calendario" | "lista";

/**
 * A VISÃO PEDIDA NA URL (#3172, item 4 do CR).
 *
 * `?visao=lista` é a forma de chegar na Lista SEM passar pelo quadro: o link
 * colado no chat, o favorito do navegador, o F5. Sem isso, a única porta para
 * a aba seria a leitura cara que ela existe para não pagar.
 *
 * Valor fora das três cai no quadro, como um `modo` de etiqueta fora dos dois
 * cai no `e` (`lib/kanban/filters.ts`): a URL é deep-link, e um parâmetro colado
 * à mão não derruba a tela.
 */
function visaoDoParam(bruto: string | null): Visao {
  return bruto === "lista" || bruto === "calendario" ? bruto : "quadro";
}

export function PipelinePageClient({
  pipelineId,
  initialName,
  role,
  funis,
  funilInicial,
  etapasIniciais,
}: {
  pipelineId: string;
  initialName: string;
  role: Role;
  /**
   * Os funis vivos da organização (`id` + `name`, na ordem da lista) — a MESMA
   * partição da tela de Funis. É o que alimenta o seletor de troca rápida do
   * cabeçalho; sem ele o quadro não sabe que existem outros funis.
   */
  funis: Array<{ id: string; name: string }>;
  /**
   * O FUNIL, da leitura leve — `crm_pipelines` menos os negócios (#3172, item 4
   * do CR). É dele que a aba Lista tira o `settings` da ficha e o vocabulário,
   * sem depender do quadro: um funil com milhares de negócios não pode ter a
   * lista refém da leitura que estoura o `statement_timeout`.
   */
  funilInicial: Pipeline;
  /** As etapas vivas, na mesma leitura leve — a lista mostra o nome de cada uma. */
  etapasIniciais: Stage[];
}) {
  const t = useT();
  /**
   * A VISÃO DO FUNIL (#2770, #3172, item 4 do CR).
   *
   * Nasce na URL (`?visao=`) e continua sendo OLHAR MOMENTÂNEO: trocar de aba
   * não é navegar, e o quadro volta no lugar onde ficou. O que mudou com o item
   * 4 é que ela passou a ser DIZÍVEL — o endereço da lista é compartilhável e
   * sobrevive ao F5 —, e é por ele que se chega na aba sem passar pelo quadro.
   *
   * `lista` é a terceira aba (#3172): uma linha por negócio, paginada no banco
   * pela rota `…/leads`. Ela NÃO reaproveita a lista que o quadro já leu — é
   * justamente o funil grande, que não cabe numa leitura só, que ela existe
   * para atender.
   */
  const searchParams = useSearchParams();
  const visaoDaUrl = visaoDoParam(searchParams.get("visao"));
  const [visao, setVisao] = useState<Visao>(visaoDaUrl);
  /**
   * O ajuste de estado no RENDER quando a URL muda — o mesmo padrão que o
   * `NewLeadDialog` usa para o contato dele. Um link para o MESMO funil com
   * `?visao=lista` é navegação de cliente: o componente não desmonta, o
   * `useState` inicial não roda de novo, e sem esta comparação a URL diria
   * "lista" enquanto a tela mostrasse o quadro — uma mentira com cara de link
   * quebrado. Em `useEffect` seria um render a mais com a tela errada na tela.
   */
  const [visaoDaUrlAnterior, setVisaoDaUrlAnterior] = useState(visaoDaUrl);
  if (visaoDaUrl !== visaoDaUrlAnterior) {
    setVisaoDaUrlAnterior(visaoDaUrl);
    setVisao(visaoDaUrl);
  }
  /**
   * ⚠️ A LEITURA CARA SÓ QUANDO ELA É A RESPOSTA (#3172, item 4 do CR).
   *
   * O quadro lê o funil INTEIRO; a lista existe para não lê-lo. Com a Lista
   * aberta, `enabled: false` desliga a consulta do quadro — e com ela o canal
   * de realtime e a rede de segurança —, e o que a tela paga é a página da
   * rota `…/leads` mais as duas consultas leves do server component.
   *
   * Quadro e Calendário continuam exatamente como hoje: as duas olham o mesmo
   * funil, e uma delas (o quadro) é quem alimenta o calendário.
   */
  const { data, isLoading, error, pulses, realtimeStatus, seguranca } = useBoard(
    pipelineId,
    searchParams.get("lead"),
    // Funil arquivado só tem o quadro (#1298): com `?visao=lista` na URL a lista
    // não é desenhada, então a consulta do quadro não pode ficar desligada pela
    // visão CRUA — a tela cairia em "Carregando…" para sempre. O funil do
    // servidor já diz se está arquivado antes de o quadro chegar.
    { enabled: visao !== "lista" || funilInicial.is_archived === true },
  );
  const router = useRouter();
  const pathname = usePathname();
  /**
   * ⚠️ O FILTRO PEDIDO VALE ANTES DE A URL CHEGAR NELE.
   *
   * `router.replace` só muda o `useSearchParams` depois da ida ao servidor
   * (o payload RSC da página). Lendo o filtro só da URL, o segundo clique feito
   * nessa janela partia do filtro VELHO: desmarcar a etiqueta A e marcar a B
   * virava "A e B", e o quadro ficava vazio. Medido no e2e (#1208, CI de
   * 30/10): o RSC levou 118 ms e o segundo clique veio 43 ms depois — numa VPS
   * lenta a janela é de quem clica, não só do robô.
   *
   * Então o filtro pedido vale até a URL mudar. O `router.replace` seguinte
   * DESCARTA o anterior ainda em voo (`actionQueue.pending.discarded` no Next
   * 16), então a URL nunca para num pedido intermediário: quando ela muda, ou é
   * o último pedido, ou é navegação de fora (voltar, link) — e a URL manda.
   */
  const [pedido, setPedido] = useState<LeadFilters | null>(null);
  const urlAtual = searchParams.toString();
  const [urlAnterior, setUrlAnterior] = useState(urlAtual);
  if (urlAtual !== urlAnterior) {
    setUrlAnterior(urlAtual);
    setPedido(null);
  }
  const filters = useMemo(
    () => pedido ?? filtersFromParams(searchParams),
    [pedido, searchParams],
  );
  const setFilters = useCallback(
    (next: LeadFilters) => {
      const p = new URLSearchParams(filtersToParams(next));
      /**
       * A VISÃO ATRAVESSA A REESCRITA DO FILTRO: ela mora na mesma query string,
       * e `filtersToParams` monta a string do zero. Digitar na busca com a
       * Lista aberta apagaria o `?visao=lista` — e o ajuste do render lá em
       * cima leria isso como "pediram o quadro", devolvendo o quadro no meio da
       * digitação.
       */
      const visaoPedida = searchParams.get("visao");
      if (visaoPedida) p.set("visao", visaoPedida);
      const qs = p.toString();
      setPedido(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  /**
   * Trocar de visão ESCREVE na URL (#3172, item 4 do CR): é o que faz o
   * endereço da Lista ser compartilhável e sobreviver ao F5. O quadro é o
   * padrão e não ganha parâmetro — link antigo não muda de significado.
   *
   * Os DEMAIS parâmetros ficam onde estão: trocar de visão não é reescrever a
   * consulta (o filtro e o `?lead=` seguem valendo quando se volta ao quadro).
   */
  const mudarVisao = useCallback(
    (proxima: Visao) => {
      setVisao(proxima);
      const p = new URLSearchParams(searchParams.toString());
      if (proxima === "quadro") p.delete("visao");
      else p.set("visao", proxima);
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  /**
   * A densidade dos cards do quadro (issue #3461, item 2). Preferência de quem
   * olha, gravada no navegador — ver `useDensidadeDoQuadro` para por que não é
   * coluna do funil nem parâmetro de URL.
   */
  const { compacta: cardsCompactos, alternar: alternarDensidade } = useDensidadeDoQuadro();

  /**
   * Motivo e categoria da perda (#1537): a categoria NÃO vem no lead — ela é
   * `settings.lost_reasons` do funil, que o payload do quadro já traz. O
   * resolvedor é o MESMO que o relatório usa (`categoriaDoMotivo`), para o
   * filtro e o relatório nunca dizerem coisas diferentes.
   */
  const categoriaDo = useMemo(() => {
    const settings = data?.pipeline.settings;
    return (motivo: string) => categoriaDoMotivo(motivo, settings);
  }, [data?.pipeline.settings]);
  const filteredLeads = data ? applyFilters(data.leads, filters, { categoriaDo }) : [];
  // NÃO é a conta do FilterBar: o seletor de filtro lista as três caixas
  // (`marcadoresDoCard`: negócio, contato e conversa), e esta lista, a da tag em
  // lote, só `lead.tags` — é lá que a ação em lote grava (#852). O `useMemo` é o
  // mesmo cuidado de lá: solta no corpo, a conta roda em toda renderização
  // e devolve um array NOVO a cada vez. E esta página re-renderiza a cada tecla
  // da busca (o debounce do FilterBar mexe na query string) e a cada mudança de
  // seleção de card.
  const tagsDoQuadro = useMemo(
    () => [...new Set((data?.leads ?? []).flatMap((l) => l.tags))].sort(),
    [data?.leads],
  );

  /**
   * FUNIL ARQUIVADO ABRE PARA OLHAR (#1298, item 1).
   *
   * A gaveta de Funis leva o nome do funil arquivado para cá — antes o único
   * caminho era desarquivar, abrir e arquivar de novo: três escritas e duas
   * linhas de auditoria para uma leitura (e a segunda escrita é a que se
   * esquece). Abrir para OLHAR só é honesto se abrir não escrever: com
   * `is_archived` no payload do quadro, esta tela desliga as escritas que ela
   * mesma oferece — criar negócio, arrastar card, menu de ações, seleção em
   * lote, renomear etapa e dossiê.
   */
  // O funil da leitura do servidor já diz se está arquivado: sem ele, o
  // "Novo Lead" e a `?visao=lista` apareceriam até o quadro carregar.
  const arquivado = (data?.pipeline ?? funilInicial).is_archived === true;
  /**
   * Funil arquivado só tem o quadro em leitura: nem `?visao=lista` escapa. A
   * Lista e o Calendário oferecem escrita de negócio, e um parâmetro colado na
   * URL não pode reabrir o que a tela acabou de fechar.
   */
  const visaoEfetiva: Visao = arquivado ? "quadro" : visao;
  const nomeAtual = data?.pipeline.name ?? initialName;
  // Um funil só = nada para trocar: o seletor seria ruído permanente.
  const podeTrocar = funis.length > 1;

  return (
    <div
      // O QUADRO CABE NA TELA. A página rolava com a janela: o quadro media o
      // que media a coluna mais comprida, e a barra de rolagem horizontal ficava
      // no pé dele — com uma etapa cheia, era preciso descer até o fim para
      // conseguir andar para o lado, e no caminho o nome da etapa sumia do alto.
      // Com a altura da área visível (100dvh menos a barra do topo, h-14, e o
      // padding do <main>), quem rola é o quadro: a barra horizontal fica sempre
      // no pé da tela e o cabeçalho de cada etapa fica preso em cima. O piso de
      // 28rem é para tela baixa demais, onde a página volta a rolar.
      //
      // ⚠️ A PARCELA DE BAIXO VEM DO CONTRATO, e era um `3rem` literal.
      //
      // Aquele literal era a segunda metade do `p-6` do `<main>` escrita à mão,
      // e ela não sabia de nenhuma peça fixa no rodapé. Com a barra de abas do
      // celular (`components/shell/BarraInferior.tsx`, 56px mais a área segura),
      // o quadro media 48px a mais do que tinha e o fim dele — justamente onde
      // mora a barra de rolagem horizontal, a razão desta linha existir —
      // passava a correr POR BAIXO das abas.
      //
      // `max(var(--space-6), var(--rodape-ocupado, 0px))` é a mesma fórmula do
      // `components/inbox/InboxLayout.tsx`, e é o que o gate
      // `tests/unit/altura-fixa-le-a-reserva-do-rodape.test.ts` cobra: altura
      // fixa não desconta número próprio, lê a reserva.
      className="flex h-[calc(100dvh-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] min-h-[28rem] flex-col gap-4"
      // OBSERVÁVEL de propósito, e é a razão de existir desta linha: "a
      // assinatura morreu" e "nada aconteceu" produzem o MESMO silêncio na
      // tela, e sem este valor nem o produto nem o teste conseguem separar as
      // duas famílias de causa. Com ele, quem investiga olha DURANTE a rodada
      // que falha: `subscribed` manda procurar a montante (entrega, filtro, ou
      // o evento nunca saiu); `channel_error`/`timed_out`/`closed` já é a
      // resposta.
      //
      // Ainda NÃO religa — religar é desenho e merece bloco próprio. Isto aqui
      // é só parar de descartar o que já era calculado.
      data-realtime-status={realtimeStatus.toLowerCase()}
      // A rede de segurança fica OBSERVÁVEL pelo mesmo motivo do status do
      // canal: "a entrega morreu" e "nada aconteceu" têm a mesma aparência, que
      // é silêncio. Aqui o número de divergências é a diferença entre os dois —
      // e é o sinal que faltava para uma verificação poder APROVAR, e não só
      // reprovar.
      data-refetch-divergencias={seguranca.divergencias}
      data-refetch-em={seguranca.ultimaVerificacao ?? ""}
    >
      {/* `flex-col` no mobile: nome de funil comprido (é texto livre, sem
          limite curto) + botão na mesma linha sem quebra empurrava o botão pra
          fora da viewport em telas estreitas. De `sm:` pra cima volta a ser
          uma linha só, como sempre foi. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/*
          O TÍTULO É O SELETOR. Com um funil só, `h1` puro (nada para trocar);
          com vários, o gatilho do `Select` veste o título e o `h1` real vai
          para `sr-only` — botão dentro de `h1` é HTML inválido, e sem o `h1`
          o leitor de tela perde o título da página. Trocar zera a query
          string: filtro de um funil aplicado no outro é resultado fantasma.
        */}
        <h1
          className={
            podeTrocar ? "sr-only" : "min-w-0 truncate text-2xl font-semibold tracking-tight"
          }
        >
          {nomeAtual}
        </h1>
        {podeTrocar && (
          <Select
            value={funis.some((f) => f.id === pipelineId) ? pipelineId : undefined}
            onValueChange={(id) => {
              if (id !== pipelineId) router.push(`/app/pipelines/${id}`);
            }}
          >
            <SelectTrigger
              aria-label={`${t("Trocar de funil")}: ${nomeAtual}`}
              data-testid="trocar-funil"
              className="h-auto w-auto max-w-full min-w-0 gap-1.5 border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight shadow-none focus:ring-1 focus:ring-ring sm:max-w-[60%] [&>span]:truncate"
            >
              <SelectValue placeholder={nomeAtual} />
            </SelectTrigger>
            <SelectContent>
              {funis.map((f) => (
                <SelectItem key={f.id} value={f.id} data-testid={`trocar-funil-opcao-${f.id}`}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/*
          AS ABAS DO FUNIL (#2770, #3172), ao lado do quadro. O seletor fica no
          cabeçalho e não dentro do conteúdo: quem troca de visão está mudando
          COMO olha o funil, e a pergunta é anterior a qualquer filtro ou card —
          é a mesma lógica do interruptor Lista/Calendário da tela de Tarefas.
          As três olham o MESMO funil e não discordam sobre quem está nele.

          A troca passa por `mudarVisao` e não por `setVisao`: a visão é da URL
          (#3172, item 4 do CR), e é o endereço que faz a aba ser alcançável sem
          passar pelo quadro.
        */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* A DENSIDADE DOS CARDS (issue #3461, item 2) mora AO LADO das abas
              da visão, e só no Quadro: é a mesma família de escolha ("como eu
              olho este funil"), mas ela não muda o que se vê — muda quanto cabe.
              Um interruptor (`aria-pressed`) e não um par de botões: são dois
              estados e o nome do controle é o estado que ele LIGA, que é a
              forma que o leitor de tela anuncia sem inventar vocabulário. */}
          {visao === "quadro" && (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={cardsCompactos}
              title={t("Cards compactos")}
              data-testid="densidade-do-quadro"
              onClick={alternarDensidade}
            >
              {t("Compacta")}
            </Button>
          )}
          {/* Funil arquivado abre só no quadro, e o quadro é leitura (#1298):
              a Lista e o Calendário têm ações de negócio, e oferecê-las num
              funil que não recebe mais escrita seria a mesma promessa falsa
              que o "Novo Lead" apagado. Por isso as abas nem aparecem. */}
          {!arquivado && (
            <div className="flex items-center gap-0.5 rounded-md border bg-muted p-0.5">
              <button
                type="button"
                data-testid="visao-quadro"
                aria-pressed={visao === "quadro"}
                onClick={() => mudarVisao("quadro")}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  visao === "quadro"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("Quadro")}
              </button>
              <button
                type="button"
                data-testid="visao-lista"
                aria-pressed={visao === "lista"}
                onClick={() => mudarVisao("lista")}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  visao === "lista"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("Lista")}
              </button>
              <button
                type="button"
                data-testid="visao-calendario"
                aria-pressed={visao === "calendario"}
                onClick={() => mudarVisao("calendario")}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  visao === "calendario"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("Calendário")}
              </button>
            </div>
          )}
          {/* O portão do diálogo é a EXISTÊNCIA DE ETAPA, não a de quadro: numa
              tela aberta direto na Lista (#3172, item 4 do CR) não há quadro, e
              um botão apagado ao lado de uma lista que abriu seria dizer que a
              aba não funciona. As etapas vêm da leitura leve. */}
          {!arquivado && (
            <Button
              onClick={() => setNewOpen(true)}
              disabled={etapasIniciais.length === 0}
              className="shrink-0"
            >
              <Plus size={16} className="mr-2" /> {t("Novo Lead")}
            </Button>
          )}
        </div>
      </header>
      {arquivado && (
        <p
          className="rounded-md border border-border bg-surface-elevated/40 p-3 text-sm leading-relaxed text-text-muted"
          data-testid="funil-arquivado-aviso"
        >
          {t(
            "Este funil está arquivado: o quadro abre em leitura, e nada aqui grava até você tirá-lo do arquivo em Funis.",
          )}{" "}
          <Link href="/app/kanban" className="underline" data-testid="funil-arquivado-ir-para-funis">
            {t("Funis")}
          </Link>
        </p>
      )}
      {etapasIniciais.length > 0 && (
        <NewLeadDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelineId={pipelineId}
          stages={data?.stages ?? etapasIniciais}
          // #1751: o quadro é a lista que o diálogo confere ANTES de criar —
          // é ela que faz o aviso de negócio duplicado existir sem rede. Quem
          // abre a tela DIRETO na Lista (#3172, item 4 do CR) não tem essa
          // lista, e quem avisa é o servidor (`meta.avisos`) — o mesmo caminho
          // de quem abre pelo Inbox, que também abre sem o quadro em mãos.
          leads={data?.leads ?? []}
          // #3038: os campos que a etapa exige são preenchidos no PRÓPRIO
          // formulário — a lista sai do `settings` que o quadro já tem em mãos.
          // Na Lista o quadro não carrega (#3172): o funil da leitura leve já
          // traz os `settings`, então o bloco de campos exigidos continua vivo.
          settings={data?.pipeline.settings ?? funilInicial.settings}
        />
      )}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        leads={data?.leads ?? []}
        settings={data?.pipeline.settings}
      />
      {visaoEfetiva === "lista" ? (
        /**
         * ⭐ A LISTA NÃO ESPERA O QUADRO (#3172, item 4 do CR) — e é por isso
         * que este ramo vem ANTES dos do quadro.
         *
         * Antes, os ramos de erro e de carregamento do quadro vinham primeiro: a
         * lista só aparecia depois que a leitura do funil INTEIRO terminasse —
         * e num funil com milhares de negócios ela é justamente a que estoura o
         * `statement_timeout`. A aba que existe para não pagar essa leitura
         * estava atrás dela.
         *
         * O que ela recebe vem da leitura LEVE (funil e etapas sem negócio
         * nenhum, do server component): nenhum `data` do quadro é consultado
         * aqui, e por isso o quadro pode estar carregando, ter falhado ou nem
         * ter sido pedido — a lista é a mesma. Também NÃO recebe
         * `filteredLeads`: ela pagina no banco, e filtrar em memória uma página
         * esconderia os negócios das seguintes. Recebe a ESCOLHA da barra
         * (`filters`), e a leva para a consulta (#3172, fatia 2 — ver o
         * cabeçalho de `ListaDoFunil`).
         */
        <ListaDoFunil
          pipelineId={pipelineId}
          pipeline={funilInicial}
          stages={etapasIniciais}
          filtros={filters}
        />
      ) : error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Não consegui carregar este funil:")} {formatError(error, t)}
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : visaoEfetiva === "calendario" ? (
        // A MESMA lista filtrada do quadro: as duas abas olham o mesmo funil,
        // e discordar sobre quem está nele seria pior do que não ter filtro.
        <CalendarioDoFunil
          pipelineId={pipelineId}
          pipeline={data.pipeline}
          stages={data.stages}
          leads={filteredLeads}
        />
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={filteredLeads}
          pulses={pulses}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          leadInicial={searchParams.get("lead")}
          podeRenomearEtapa={!arquivado && ROLE_RANK[role] >= ROLE_RANK.manager}
          denso={cardsCompactos}
          somenteLeitura={arquivado}
        />
      )}
      {!arquivado && (
        <BulkActionBar
          selectedIds={selectedIds}
          stages={data?.stages ?? []}
          pipelineId={pipelineId}
          vocabulary={data?.pipeline.vocabulary ?? null}
          tagsExistentes={tagsDoQuadro}
          onClear={() => setSelectedIds([])}
        />
      )}
    </div>
  );
}
