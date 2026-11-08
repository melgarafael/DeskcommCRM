"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, usePermission, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { ArrowLeft, ArrowsOutSimple } from "@/lib/ui/icons";
import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { AtalhosDoNegocio } from "./AtalhosDoCard";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm, type ControleDosCamposDoNegocio } from "./LeadFieldsForm";
import { RevisaoDoDocumento } from "./RevisaoDoDocumento";
import { ScoreSlot } from "./ScoreSlot";
import { LeadTimeline } from "./LeadTimeline";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { TarefasDoNegocio } from "./TarefasDoNegocio";
import { OwnerBadge } from "./OwnerBadge";
import { EtapaNoDossie } from "./EtapaNoDossie";
import { SecaoDoDossie, useSecoesRecolhidas } from "./SecaoDoDossie";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { AtalhoDoCard } from "@/lib/leads/atalhos-do-card";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

interface Props {
  /**
   * No painel, quem manda é a gaveta. Na página inteira não há o que fechar — o
   * padrão é aberto e o valor não é lido.
   */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /**
   * A MOLDURA (#4151): `painel` é a gaveta lateral de sempre; `pagina` é a
   * página inteira, com cabeçalho próprio e duas colunas no desktop.
   *
   * ─── Por que uma VARIANTE, e não um componente de conteúdo extraído ────────
   *
   * O caminho preferido era extrair o conteúdo para um `ConteudoDoDossie` e
   * montá-lo dos dois lados. A extração ameaça o drawer: cinco provas de
   * regressão leem `LeadDossier.tsx` como FONTE — a ordem `ConversaNoDossie`
   * antes de `LeadTimeline` (`tests/unit/dossie-atalho-conversa`), o
   * `LeadFieldsForm` montado aqui (`campo-condicional-nos-pontos-de-renderizacao`),
   * o `<ContatoDoNegocio contactId={lead.contact_id} pipelineId={pipelineId}>`
   * (`funil-mostra-dados-do-cliente`), o `<EtapaNoDossie … onMudar={onMudarEtapa}>`
   * com a régua de mover card (`etapa-pelo-dossie`) e a presença dos dois blocos
   * que o card compacto esconde (`KanbanCard.densidade`). Mover o conteúdo é
   * mover a composição que esses testes cobram do arquivo — e o conserto seria
   * reescrever teste alheio para acompanhar o refactor, que é exatamente o que
   * esta onda não faz.
   *
   * Com a variante, o drawer continua montando o que sempre montou, os blocos
   * são os MESMOS objetos nos dois formatos (as variáveis abaixo), e a página não
   * ganha uma segunda cópia de nada.
   */
  variante?: "painel" | "pagina";
  /**
   * O endereço da página inteira do negócio (`/app/leads/[id]?voltar=…`).
   * Só o QUADRO passa: a lista e o calendário continuam abrindo o painel, e o
   * botão não aparece onde não há página para onde ir.
   */
  expandirHref?: string;
  /** O destino do "Voltar" da página inteira — ver `lib/leads/pagina-do-negocio`. */
  voltarHref?: string;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
  /**
   * As etapas do funil e quem move. Presentes (o quadro passa), o cabeçalho
   * troca o nome da etapa por um seletor — ver `EtapaNoDossie`. Ausentes (o
   * calendário, por enquanto), fica o texto de antes.
   */
  etapas?: Pick<Stage, "id" | "name">[];
  onMudarEtapa?: (stageId: string) => void;
  /**
   * OS ATALHOS DO CARD (#3487): o que está em `crm_pipelines.settings.atalhos`,
   * já lido por `atalhosDoFunil`. Quem monta o dossiê tem o funil em mão — o
   * quadro, a lista e o calendário recebem `pipeline`/`funil` inteiros —, então
   * a lista vem por prop em vez de o dossiê sair buscando por conta própria.
   * Ausente = nenhum botão, que é o comportamento de antes da entrega.
   */
  atalhos?: AtalhoDoCard[];
}

function formatValor(cents: number | null, currency: string | null): string {
  // Mesma régua e mesmo locale do card e do total da coluna (`formatValorDoNegocio`).
  if (cents === null) return "—";
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/**
 * O dossiê do negócio: cabeçalho vivo → Contato → Dados do negócio → Linha do
 * tempo (issue #3181).
 *
 * ─── A ORDEM, e por que ela inverteu ────────────────────────────────────────
 *
 * A ordem antiga era Contato → Linha do tempo → Dados do negócio, e o argumento
 * dela era bom: quem abre um lead quer primeiro saber O QUE ACONTECEU. O que ela
 * não previu foi o crescimento da linha do tempo. Com uso real, mensagens,
 * mudanças de etapa, automações e follow-ups empurram os CAMPOS DO FUNIL para
 * baixo de uma parede de rolagem — e os campos são justamente o que se preenche
 * durante o atendimento (destino, datas, passageiros, produtos vendidos). A
 * ordem dos campos já segue a lógica do atendimento; com a linha do tempo no
 * meio, essa lógica se perdia e os campos ficavam vazios.
 *
 * A inversão não joga a linha do tempo fora: ela passa a ser a CONSULTA, depois
 * do que se PREENCHE. E as três seções viraram recolhíveis, com o estado
 * lembrado, para quem quiser o contrário de volta.
 *
 * ─── O estado lembrado é POR NAVEGADOR ──────────────────────────────────────
 *
 * A preferência que já existe (`interface_settings`) é da ORGANIZAÇÃO e exige
 * papel de admin para ser escrita — reclinar uma seção mudaria a tela de todo
 * mundo. O pedido foi "por usuário", então o estado vai para o `localStorage`
 * (ver `SecaoDoDossie.tsx`, que declara o custo). Não nasceu schema novo.
 *
 * Fora deste PR: a sugestão 3 do autor (ordem das seções configurável por
 * funil) — ela pede uma preferência por FUNIL, que hoje não existe em lugar
 * nenhum, e não caberia sem inventar schema.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 *
 * ─── A PÁGINA INTEIRA (#4151) ───────────────────────────────────────────────
 *
 * O painel de 28rem é bom para espiar e ruim para trabalhar: duas colunas de
 * campos, a descrição e a linha do tempo não cabem lado a lado, e o histórico
 * empurra o formulário para fora da vista. A `variante="pagina"` desenha o MESMO
 * conteúdo em página: cabeçalho com nome, etapa e valor; dados e descrição à
 * esquerda, tarefas e linha do tempo à direita no desktop; uma coluna na tela
 * estreita. Nada aqui é uma segunda implementação — são as mesmas variáveis de
 * bloco montadas noutra moldura.
 */

/** Quantas entradas a linha do tempo mostra com a seção recolhida (#3181). */
const ENTRADAS_COM_A_LINHA_RECOLHIDA = 3;

export function LeadDossier({
  open = true,
  onOpenChange,
  variante = "painel",
  expandirHref,
  voltarHref,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
  etapas,
  onMudarEtapa,
  atalhos,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  // Sem prop, nenhum botão: quem abre o dossiê TEM o funil em mão (o quadro, a
  // lista e o calendário passam `atalhos`) e é de lá que sai o `settings`. Ler
  // o cache do react-query aqui dentro custaria um `QueryClientProvider`
  // obrigatório em todo teste que monta o dossiê — inclusive os que existiam
  // antes desta entrega — para economizar uma prop que o chamador já tem.
  const atalhosDoCard = atalhos ?? [];
  const campos = useRef<HTMLDivElement | null>(null);
  const formulario = useRef<ControleDosCamposDoNegocio | null>(null);
  const naPagina = variante === "pagina";
  // A página inteira não tem "aberto/fechado": ela É o negócio. A gaveta
  // continua lendo a prop — é ela que diz quando buscar a linha do tempo.
  const emFoco = naPagina || open;
  const timeline = useLeadTimeline(emFoco ? lead.id : null, lead.contact_id);
  const { fechadas, alternar, abrir } = useSecoesRecolhidas();
  const timelineRecolhida = fechadas.has("linha-do-tempo");
  // As três MAIS RECENTES: a rota devolve `performed_at` decrescente, então o
  // corte é no início da lista, não no fim.
  const itensDaTimeline = timelineRecolhida
    ? timeline.itens.slice(0, ENTRADAS_COM_A_LINHA_RECOLHIDA)
    : timeline.itens;
  const temMaisNaTimeline = timeline.itens.length > ENTRADAS_COM_A_LINHA_RECOLHIDA;
  // O atalho do cabeçalho precisa rolar DEPOIS de a seção estar aberta: rolar
  // num mesmo tique mediria a altura de antes, com os campos ainda escondidos.
  const [pedidoDeRolagem, setPedidoDeRolagem] = useState(0);
  useEffect(() => {
    if (pedidoDeRolagem === 0) return;
    campos.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pedidoDeRolagem]);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  // N1 — o atalho "Nova proposta" é manager+ (mesmo gate do envio, mesma
  // régua do BulkActionBar). O dossiê não tinha nenhuma checagem de papel;
  // esta é a primeira, no padrão já estabelecido do kanban.
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin ||
    (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) ||
    false;
  // A MESMA régua do arrasto e do "Mover para…" do card (`KanbanCardActions`).
  const podeMoverCard = usePermission("pipeline.move_card");
  const podeCriarContato = usePermission("contact.create");
  // Tarefas são `agent`+, a mesma régua da tela de Tarefas e da rota — e o
  // suporte temporário só lê, como lá (`requireSupportWrite`).
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);
  // Confirmar o que o documento disse é EDITAR O CARD: `agent`+, a MESMA régua
  // que a rota de decisão exige (`requireRole("agent")`). Abaixo disso a fila
  // ainda aparece — ler o que a IA leu é informação —, mas sem os botões.
  const podeConfirmarDoDocumento = podeEditarTarefas;

  /**
   * As props da linha do tempo, montadas UMA vez e usadas nos dois estados da
   * seção. Duplicar o bloco seria a maneira mais fácil de os dois divergirem —
   * e o recolhido é justamente o estado menos olhado por quem revisa.
   *
   * São as props, e não o elemento da linha do tempo já montado numa variável
   * lá em cima: `tests/unit/dossie-atalho-conversa` prova que o bloco da
   * conversa aparece ANTES da linha do tempo lendo a posição do primeiro
   * elemento dela no arquivo, e uma variável içada para o topo do componente
   * inverteria essa leitura sem nada ter mudado na tela — o teste passaria a
   * medir a posição de uma variável, e não da seção.
   */
  const propsDaLinhaDoTempo = {
    itens: itensDaTimeline,
    chegouAoVivo: timeline.chegouAoVivo,
    isLoading: timeline.isLoading,
    isError: timeline.isError,
  };

  /**
   * ⭐ OS BLOCOS, MONTADOS UMA VEZ (#4151).
   *
   * Cada variável é o MESMO elemento nos dois formatos: a gaveta empilha, a
   * página distribui em colunas. Antes desta entrega, uma página inteira só
   * existiria como uma segunda cópia desta composição — e a cópia que ninguém
   * revisita é a que diverge.
   */
  const cabecalhoVivo = (
    /* ① cabeçalho vivo */
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border pb-3 text-xs">
      <span className="font-medium text-text tabular-nums">
        {formatValor(lead.value_cents, lead.currency)}
      </span>
      {etapas && onMudarEtapa ? (
        <EtapaNoDossie
          etapaAtual={lead.stage_id}
          etapas={etapas}
          podeMover={podeMoverCard}
          onMudar={onMudarEtapa}
        />
      ) : (
        <span className="text-text-muted">{stageName}</span>
      )}
      <OwnerBadge
        ownerKind={owner.kind}
        ownerName={owner.name}
        agentVersion={owner.agentVersion}
      />
      {score && (
        // O MESMO componente do card, não uma cópia do medidor.
        // "Superfície nova herda as decisões da antiga" só vale como
        // mecanismo: herdar por cópia é como as duas listas do evidence —
        // funciona hoje e diverge no mês em que alguém mudar um dos dois.
        // De brinde, o rótulo honesto da âncora ("registro que sustenta",
        // nunca "momento da conversa") vem junto, sem eu reescrever nada.
        <ScoreSlot
          probability={score.probability}
          band={score.band}
          reason={score.reason}
          factors={score.factors.slice(0, 3)}
        />
      )}

      <button
        type="button"
        onClick={() => {
          // Se os campos estiverem recolhidos, o clique também os abre:
          // rolar até um título fechado entregaria um destino vazio.
          abrir("dados-do-negocio");
          setPedidoDeRolagem((n) => n + 1);
        }}
        className="ml-auto text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {t("Editar campos")}
      </button>
    </div>
  );

  /* O score NÃO aparece na timeline: recálculo é telemetria e não emite
     atividade (silêncio para telemetria, pulso para mudança de estado).
     Sem esta linha, quem visse o número mudando no cabeçalho e nunca na
     timeline concluiria que a timeline está incompleta. */
  const carimboDoScore = score?.at ? (
    <p className="pt-2 text-[11px] text-text-muted">
      {t("Probabilidade recalculada automaticamente")} ·{" "}
      {new Date(score.at).toLocaleString(tagDoIdioma)}
    </p>
  ) : null;

  /* OS ATALHOS DO CARD (#3487) — logo abaixo do cabeçalho, ANTES de
     tudo que rola. A entrega inteira existe para o atendente não sair do
     card: um botão que exige rolar até o fim é o mesmo que copiar o
     telefone e colar no softphone. Sem atalho configurado, nada é
     desenhado — nem separador, nem faixa vazia. */
  const atalhosDoNegocio = (
    <AtalhosDoNegocio atalhos={atalhosDoCard} lead={lead} contactId={lead.contact_id} />
  );

  const conversa = (
    <ConversaNoDossie
      conversa={lead.conversa}
      contactId={lead.contact_id}
      phone={lead.contact_phone}
    />
  );

  /* ① Contato — os dados do CLIENTE: telefone e e-mail numa aba, links
     (Instagram, site, Google Meu Negócio…) na outra. Vêm do contato, não
     do lead. Primeira porque é o contexto de quem está falando. */
  const contato = (
    <SecaoDoDossie
      id="contato"
      titulo={t("Contato")}
      recolhida={fechadas.has("contato")}
      aoAlternar={alternar}
    >
      <ContatoDoNegocio
        contactId={lead.contact_id}
        pipelineId={pipelineId}
        leadId={lead.id}
        lead={lead}
        podeCriarContato={podeCriarContato}
      />
    </SecaoDoDossie>
  );

  /* ② Dados do negócio — o que se PREENCHE, agora ANTES da linha do
     tempo (#3181). */
  const dadosDoNegocio = (
    <SecaoDoDossie
      id="dados-do-negocio"
      titulo={t("Dados do negócio")}
      recolhida={fechadas.has("dados-do-negocio")}
      aoAlternar={alternar}
    >
      <div ref={campos}>
        {/* ⚠️ A REVISÃO FICA AQUI, dentro do card, e é esta linha que o
            mantenedor cobrou no #3415: a fila existia como API e não tinha
            consumidor na tela — o mesmo que não existir. Acima do
            formulário porque é o histórico do que o documento disse, e o
            formulário é o destino do que for confirmado. */}
        <RevisaoDoDocumento
          leadId={lead.id}
          podeDecidir={podeConfirmarDoDocumento}
          aoDecidir={(confirmado) => formulario.current?.confirmarCampo(confirmado)}
        />
        <LeadFieldsForm
          lead={lead}
          pipelineId={pipelineId}
          fieldDefs={fieldDefs}
          controle={formulario}
          // Na página, a descrição ganha a área de texto alta: é o campo que
          // se lê e se reescreve, não uma linha de apoio ao lado de outros
          // cinco. No painel de 28rem, três linhas seguem sendo o certo.
          descricaoAlta={naPagina}
        />
      </div>
    </SecaoDoDossie>
  );

  /* As tarefas SEGUEM antes da linha do tempo: a timeline conta o que já
     aconteceu, a tarefa é o que ainda falta fazer — e quem abre o card
     para agir procura o próximo passo primeiro. Não entram no
     recolhimento deste PR: o autor citou as três seções acima, e tarefa
     é trabalho em curso, não consulta. */
  const tarefas = (
    <TarefasDoNegocio
      leadId={lead.id}
      contactId={lead.contact_id}
      podeEditar={podeEditarTarefas}
      aberto={emFoco}
    />
  );

  /* ③ Linha do tempo — a CONSULTA, por último. Recolhida, mostra as três
     entradas mais recentes e o "ver tudo" (pedido do autor): a seção
     fecha sem deixar a pergunta "e o que aconteceu por último?" sem
     resposta. */
  const linhaDoTempo = (
    <SecaoDoDossie
      id="linha-do-tempo"
      titulo={t("Linha do tempo")}
      recolhida={timelineRecolhida}
      aoAlternar={alternar}
      className={naPagina ? undefined : "flex-1"}
      conteudoRecolhido={
        <>
          <LeadTimeline {...propsDaLinhaDoTempo} />
          {/* Só quando há o que ver: "ver tudo" numa lista de três seria um
              botão que não leva a lugar nenhum. */}
          {temMaisNaTimeline && (
            <button
              type="button"
              onClick={() => alternar("linha-do-tempo")}
              className="mt-2 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              {t("Ver tudo")}
            </button>
          )}
        </>
      }
    >
      <LeadTimeline {...propsDaLinhaDoTempo} />
    </SecaoDoDossie>
  );

  /* N1 — seção "Propostas", depois da linha do tempo. Some sozinha
     (null) quando a capacidade está desligada — ver PropostasDoNegocio. */
  const propostas = (
    <PropostasDoNegocio
      leadId={lead.id}
      pipelineId={pipelineId}
      podeCriar={podeCriarProposta}
    />
  );

  /**
   * ⭐ A PÁGINA INTEIRA (#4151).
   *
   * Duas colunas a partir de `lg`: à esquerda o que se LÊ e se PREENCHE (contato
   * e dados do negócio, com a descrição alta); à direita o que se ACOMPANHA
   * (tarefas, linha do tempo, propostas). Em tela estreita, `grid-cols-1` — a
   * mesma ordem de leitura do painel, sem rolagem lateral.
   *
   * Os observáveis (`data-realtime-status`, `data-refetch-divergencias`) vêm
   * junto: a pergunta "a assinatura morreu ou nada aconteceu?" não pode
   * depender de o negócio ter sido aberto na gaveta.
   */
  if (variante === "pagina") {
    return (
      <div
        className="mx-auto flex w-full max-w-6xl flex-col gap-4"
        data-variante="pagina"
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        <header className="flex flex-col gap-2 border-b border-border pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href={voltarHref ?? "#"}
              data-testid="negocio-voltar"
              className="inline-flex items-center gap-1.5 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              <ArrowLeft size={14} aria-hidden />
              {t("Voltar")}
            </Link>
            {expandirHref && (
              <Link
                href={expandirHref}
                data-testid="negocio-expandir"
                className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {t("Expandir")}
              </Link>
            )}
          </div>
          <h1
            className="min-w-0 text-2xl leading-8 font-semibold tracking-tight break-words"
            data-testid="negocio-titulo"
          >
            {lead.title}
          </h1>
          {cabecalhoVivo}
          {carimboDoScore}
        </header>

        {atalhosDoNegocio}
        {conversa}

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2" data-testid="negocio-colunas">
          {/* O que se lê e se preenche. */}
          <div className="flex min-w-0 flex-col gap-4">
            {contato}
            {dadosDoNegocio}
          </div>
          {/* O que se acompanha. */}
          <div className="flex min-w-0 flex-col gap-4">
            {tarefas}
            {linhaDoTempo}
            {propostas}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md"
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        // Observável como no board: "a entrega morreu" e "nada aconteceu"
        // têm a mesma aparência, e no dossiê a segunda é ainda mais crível —
        // negócio sem novidade é um estado normal.
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        {/*
          O CABEÇALHO NÃO DISPUTA COM O X (#4151).

          O fechar da gaveta é `absolute top-4 right-4` (`components/ui/sheet`),
          com alvo de 44px: a borda esquerda dele fica a 60px da borda do painel
          no celular. O `pr-12` (48px) do cabeçalho, somado ao `p-6` do SheetContent,
          termina o conteúdo a 72px — o Expandir encosta no limite do texto e
          nunca embaixo do alvo do fechar.
        */}
        <SheetHeader className="pb-3 pr-12">
          <div className="flex items-start gap-3">
            <SheetTitle className="min-w-0 flex-1 text-base leading-6">{lead.title}</SheetTitle>
            {expandirHref && (
              <Link
                href={expandirHref}
                data-testid="dossie-expandir"
                className="inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                <ArrowsOutSimple size={12} aria-hidden />
                {t("Expandir")}
              </Link>
            )}
          </div>
        </SheetHeader>

        {cabecalhoVivo}
        {carimboDoScore}
        {atalhosDoNegocio}
        {conversa}
        {contato}
        {dadosDoNegocio}
        {tarefas}
        {linhaDoTempo}
        {propostas}
      </SheetContent>
    </Sheet>
  );
}
