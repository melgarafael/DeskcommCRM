"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { recursosDaBarra, type Recurso } from "@/lib/inbox/recursos";
import { secoesDeRespostas, type GrupoDeRespostas } from "@/lib/templates/grupos";
import {
  lerRespostaRapidaGravada,
  type ConteudoDeRespostaRapida,
  type LeituraDeRespostaRapida,
} from "@/lib/inbox/resposta-rapida";
import {
  RECURSOS_VISIVEIS_RECOLHIDA,
  armazenamentoDoNavegador,
  chaveDaBarra,
  gravarBarraAberta,
  lerBarraAberta,
  recursosVisiveis,
  type StorageLeve,
} from "@/lib/inbox/barra-de-respostas";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * A barra de recursos do Inbox (#2833): um botão por TÍTULO cadastrado. É o
 * que a issue pede — "botões automáticos e clicáveis diretamente no Inbox" —
 * em vez de obrigar o operador a decorar um atalho de barra.
 *
 * O clique NÃO envia nada: só entrega o recurso escolhido ao compositor, que o
 * passa ao MESMO `applyTemplate` do `/` — texto cai no campo editável, mídia
 * (imagem OU áudio) entra na fila de anexos. Por isso este componente é burro de
 * propósito: ele não conhece envio nem a natureza do recurso além do ícone.
 *
 * ─── A MARCAÇÃO "Mostrar na barra do Inbox" (#3282) ─────────────────────────
 *
 * Nem toda resposta rápida é para escolher à mão: há modelos usados só pelo
 * atalho `/` que poluíam a barra. A barra desenha só o que veio marcado — a
 * régua é `recursosDaBarra`, e a AUSÊNCIA da marcação conta como ligada, para a
 * organização que nunca mexeu continuar vendo tudo. O `/` continua listando
 * TODAS: esconder um botão aqui não tira a resposta do atalho.
 *
 * ─── O RECOLHIMENTO, e a memória dele ───────────────────────────────────────
 *
 * Recolhida, a barra ocupa uma linha com "mais (N)"; aberta, mostra todas. O
 * estado é POR USUÁRIO e sobrevive ao recarregar (`localStorage`, decisão da
 * issue — o produto não tem tabela de preferência por usuário).
 *
 * A leitura é num `useEffect`, não na inicialização do estado: o `localStorage`
 * não existe no servidor, e ler no render faria o HTML nascer recolhido e pular
 * para aberto na hidratação. É o mesmo desenho das divisórias do Inbox (#2579).
 *
 * ─── UMA LINHA SÓ, COM ROLAGEM LATERAL (#3875) ──────────────────────────────
 *
 * A barra era `flex-wrap`: cada resposta a mais virava mais uma linha ACIMA do
 * campo de digitação, e o preço era a altura da conversa — numa agência com
 * dezenas de respostas a seção comia metade do fio. Agora ela é uma linha que
 * NÃO quebra (`flex-nowrap`) e rola no eixo horizontal (`overflow-x-auto`), com
 * `shrink-0` em cada item: sem isso o navegador espremeria as pílulas em vez de
 * rolar, e o rótulo de cada resposta deixaria de ser legível.
 *
 * A barra NÃO tem teto de largura (`max-w-*`): em tela grande ela ocupa o
 * compositor inteiro e as respostas cabem sem rolar — carrossel apertado em
 * desktop seria trocar um defeito por outro. Rolagem de verdade é só o caso de
 * MUITOS itens ou tela estreita.
 *
 * ─── O GRUPO É UM POPUP, NÃO UM CABEÇALHO SEGUIDO DE BOTÕES (#3875) ─────────
 *
 * Antes, cada grupo despejava TODAS as suas respostas na mesma área vertical,
 * com um rótulo em cima: a barra crescia com o cadastro, não com a tela. Agora
 * o grupo é um único botão — só o nome — que abre um painel flutuante com as
 * respostas dele. O painel é o da casa (`components/ui/popover.tsx`, Radix), o
 * MESMO que o "+" do compositor usa: nada de um terceiro tipo de camada
 * flutuante no Inbox.
 *
 * `modal={false}` é deliberado: o painel não pode sequestrar o foco da conversa
 * (nem esconder o fio de leitores de tela atrás de `aria-hidden`). Abrir com
 * teclado, `Escape` para fechar e o foco voltando para o gatilho são o
 * comportamento padrão do Radix — este componente não reimplementa nenhum deles.
 *
 * Grupo VAZIO não vira gatilho: popup sem resposta é popup quebrado, e um grupo
 * recém-criado ainda não tem o que oferecer ao atendente — ele é da TELA de
 * cadastro, não da conversa.
 *
 * ─── O ÍCONE É A RÉGUA, NÃO UM `if` DE ÁUDIO (#3009) ────────────────────────
 *
 * O botão diz o que o clique prepara: só texto (o título, como sempre), imagem,
 * áudio, ou a combinação. Quem responde isso é `lerRespostaRapidaGravada` — a
 * MESMA régua que o envio (`Composer.applyTemplate`) consulta para recusar uma
 * resposta vazia. Um `if` de áudio aqui e outro no compositor foi exatamente o
 * que deixou texto+áudio e imagem+áudio sem existir: cada lado via o recurso de
 * um jeito.
 *
 * O que NÃO mudou: resposta só de texto continua saindo como `título`, sem
 * ícone nenhum, e só de áudio continua com o 🎧 na frente — o caso de 99% da
 * base sai byte a byte como antes.
 */
interface Props {
  recursos: Recurso[];
  onEscolher: (recurso: Recurso) => void;
  disabled?: boolean;
  /**
   * Por que os botões estão desligados, quando o compositor sabe dizer
   * (#3354: "há rascunho no campo, e a resposta rápida o substituiria").
   */
  dica?: string;
  /** O usuário logado — a memória do recolhimento é POR usuário (#3282). */
  usuarioId?: string | null;
  /**
   * Injeção do armazenamento, só para teste. `undefined` (o caso de produção)
   * resolve o `localStorage` do navegador; `null` é "sem memória".
   */
  storage?: StorageLeve | null;
  /**
   * Os GRUPOS de respostas rápidas (#3245). Vazio/ausente = o recurso não
   * existe para esta empresa, e a barra é a de hoje, byte a byte.
   */
  grupos?: GrupoDeRespostas[] | null;
}

/**
 * O ícone de cada conteúdo DE MÍDIA. O texto não tem ícone de propósito: ele é
 * o próprio título do botão, e um 📝 na frente mudaria o rótulo de toda resposta
 * rápida de texto — o caso que não podia mudar de aparência.
 */
const ICONE_DO_CONTEUDO: Record<Exclude<ConteudoDeRespostaRapida, "texto">, string> = {
  imagem: "🖼",
  audio: "🎧",
};

/**
 * A LINHA DA BARRA — uma só, em qualquer largura (#3875).
 *
 * `flex-nowrap` + `overflow-x-auto` são o conserto do defeito da issue; o
 * `w-full` garante que a rolagem aconteça na largura do compositor, e não numa
 * caixa encolhida ao conteúdo (que é o que faria o desktop parecer carrossel).
 *
 * Sem altura própria e sem `pb-*`: quando as respostas CABEM (o caso de desktop
 * com um cadastro normal), a linha mede exatamente o que media antes do #3875 —
 * o conserto não pode entregar 2px a mais justamente onde não havia defeito.
 * Quando há rolagem, o navegador desenha a barra fina do tema dentro da própria
 * linha; isso custa uma altura fixa de barra de rolagem, nunca uma linha nova
 * por resposta.
 */
const CLASSE_DA_BARRA =
  "flex w-full flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden mb-1.5";

/**
 * O rótulo do botão: os ícones das mídias que o clique prepara, na ordem
 * canônica (imagem, áudio), e o título. Sem mídia, o título SOZINHO — é o
 * rótulo de antes, byte a byte.
 */
function rotuloDoBotao(leitura: LeituraDeRespostaRapida, titulo: string): string {
  if (!leitura.ok) return titulo;
  const icones = leitura.conteudos
    .filter((conteudo): conteudo is Exclude<ConteudoDeRespostaRapida, "texto"> => conteudo !== "texto")
    .map((conteudo) => ICONE_DO_CONTEUDO[conteudo]);
  return icones.length ? `${icones.join("")} ${titulo}` : titulo;
}

export function BarraDeRecursos({
  recursos,
  onEscolher,
  disabled = false,
  dica,
  usuarioId = null,
  storage,
  grupos = null,
}: Props) {
  const t = useT();
  const guarda = storage === undefined ? armazenamentoDoNavegador() : storage;
  const chave = chaveDaBarra(usuarioId);
  const [aberta, setAberta] = useState(false);

  // A memória entra depois da montagem: no servidor não há `localStorage`, e o
  // HTML recolhido é o padrão — a leitura o corrige sem pular layout.
  useEffect(() => {
    setAberta(lerBarraAberta(guarda, chave));
  }, [guarda, chave]);

  const daBarra = recursosDaBarra(recursos);
  if (daBarra.length === 0) return null;

  const { visiveis, restantes } = recursosVisiveis(daBarra, aberta);
  const podeRecolher = daBarra.length > RECURSOS_VISIVEIS_RECOLHIDA;

  function alternar() {
    const proxima = !aberta;
    setAberta(proxima);
    gravarBarraAberta(guarda, chave, proxima);
  }

  // Sem grupo, o caminho é o de hoje: `secoesDeRespostas` devolve `null` e a
  // barra desenha a lista plana do MESMO markup (o componente abaixo é o que
  // ela sempre foi). Com grupo, cada grupo vira UM gatilho de popup no lugar do
  // rótulo seguido de botões — e o recolhimento continua valendo, porque as
  // seções saem dos recursos JÁ recortados (`visiveis`).
  const secoes = secoesDeRespostas(visiveis, grupos);
  const controles = (
    <>
      {restantes > 0 && (
        <button
          type="button"
          aria-expanded={false}
          onClick={alternar}
          className="shrink-0 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          {t("mais")} ({restantes})
        </button>
      )}
      {aberta && podeRecolher && (
        <button
          type="button"
          aria-expanded
          onClick={alternar}
          className="shrink-0 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          {t("menos")}
        </button>
      )}
    </>
  );

  if (secoes) {
    return (
      <div
        data-testid="barra-de-recursos"
        role="toolbar"
        aria-label={t("Respostas rápidas")}
        className={CLASSE_DA_BARRA}
      >
        {secoes
          .filter((secao) => secao.respostas.length > 0)
          .map((secao) =>
            secao.grupo ? (
              // Grupo: UM botão com o nome; as respostas moram no painel.
              <GrupoEmPopup
                key={secao.grupo.id}
                grupo={secao.grupo}
                respostas={secao.respostas}
                disabled={disabled}
                dica={dica}
                onEscolher={onEscolher}
              />
            ) : (
              // Sem grupo: os botões soltos de sempre, a um clique. O caminho
              // curto não pode ganhar um popup no meio (#3875).
              secao.respostas.map((recurso) => (
                <BotaoDeRecurso
                  key={recurso.id}
                  recurso={recurso}
                  disabled={disabled}
                  dica={dica}
                  onEscolher={onEscolher}
                />
              ))
            ),
          )}
        {controles}
      </div>
    );
  }

  return (
    <div
      data-testid="barra-de-recursos"
      role="toolbar"
      aria-label={t("Respostas rápidas")}
      className={CLASSE_DA_BARRA}
    >
      {visiveis.map((recurso) => (
        <BotaoDeRecurso
          key={recurso.id}
          recurso={recurso}
          disabled={disabled}
          dica={dica}
          onEscolher={onEscolher}
        />
      ))}
      {controles}
    </div>
  );
}

/**
 * O GRUPO COMO GATILHO (#3875) — um botão com o nome do grupo e o painel
 * flutuante com as respostas dele.
 *
 * O estado aberto/fechado é LOCAL e por grupo: abrir "Abordagem" não abre
 * "Fechamento", e não há motivo para lembrar disso entre recarregamentos (um
 * painel que reabre sozinho cobriria a conversa que ele veio devolver).
 *
 * Escolher uma resposta fecha o painel ANTES de entregar o recurso: o que vem
 * depois do clique (prévia de anexo, texto no campo) é do compositor, e deixar
 * um painel flutuante por cima disso esconde do operador o que ele acabou de
 * preparar.
 */
function GrupoEmPopup({
  grupo,
  respostas,
  disabled,
  dica,
  onEscolher,
}: {
  grupo: GrupoDeRespostas;
  respostas: Recurso[];
  disabled: boolean;
  dica?: string;
  onEscolher: (recurso: Recurso) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);

  return (
    <Popover open={aberto} onOpenChange={setAberto} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-grupo-de-recursos={grupo.id}
          disabled={disabled}
          // Quando o compositor sabe por que está travado (#3354), o motivo vai
          // no gatilho também: um grupo que não abre sem explicação é pior que
          // um botão desligado.
          title={dica}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {grupo.name}
          {/* A contagem é informação VISUAL: o nome acessível do gatilho é o
              nome do grupo ("Abordagem"), não "Abordagem 2". */}
          <span
            aria-hidden
            className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground"
          >
            {respostas.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        aria-label={`${t("Respostas do grupo")}: ${grupo.name}`}
        className="w-64 p-1"
      >
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">
          {grupo.name}
        </p>
        <div data-testid="respostas-do-grupo" className="max-h-64 space-y-0.5 overflow-y-auto">
          {respostas.map((recurso) => (
            <BotaoDeRecurso
              key={recurso.id}
              recurso={recurso}
              disabled={disabled}
              dica={dica}
              bloco
              onEscolher={(escolhido) => {
                setAberto(false);
                onEscolher(escolhido);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * O botão de UM recurso — o mesmo markup na barra plana e no painel do grupo.
 * Extraído para a barra agrupada não divergir da plana em rótulo, `title` ou
 * atributo de teste que um e2e procura.
 *
 * `bloco` é o do painel do grupo (#3875): o mesmo conteúdo, mas ocupando a linha
 * inteira e alinhado à esquerda, que é como se lê uma lista de escolhas.
 */
function BotaoDeRecurso({
  recurso,
  disabled,
  dica,
  bloco = false,
  onEscolher,
}: {
  recurso: Recurso;
  disabled: boolean;
  dica?: string;
  bloco?: boolean;
  onEscolher: (recurso: Recurso) => void;
}) {
  const t = useT();
  // A régua decide o rótulo, o `data-recurso-tipo` e o motivo do título — os
  // três leem a MESMA leitura, e o envio lê a mesma função (#3009).
  const leitura = lerRespostaRapidaGravada(recurso);
  // O bloqueio do compositor e a invalidade do conteúdo são informações
  // diferentes: quando coexistem, nenhuma pode esconder a outra.
  const motivos = [dica, leitura.ok ? undefined : t(leitura.motivo)].filter(
    (motivo): motivo is string => motivo !== undefined,
  );
  return (
    <button
      type="button"
      disabled={disabled}
      data-recurso-id={recurso.id}
      data-recurso-tipo={leitura.ok ? leitura.tipo : "invalida"}
      onClick={() => onEscolher(recurso)}
      title={motivos.length ? motivos.join(" — ") : t("Prepara no compositor — você revisa e envia")}
      className={
        bloco
          ? "flex min-h-11 w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 lg:min-h-0"
          : "shrink-0 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
      }
    >
      {rotuloDoBotao(leitura, recurso.title)}
    </button>
  );
}
