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
  // ela sempre foi). Com grupo, cada grupo vira um rótulo seguido dos botões
  // dele — e o recolhimento continua valendo, porque as seções saem dos
  // recursos JÁ recortados (`visiveis`).
  const secoes = secoesDeRespostas(visiveis, grupos);
  const controles = (
    <>
      {restantes > 0 && (
        <button
          type="button"
          aria-expanded={false}
          onClick={alternar}
          className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          {t("mais")} ({restantes})
        </button>
      )}
      {aberta && podeRecolher && (
        <button
          type="button"
          aria-expanded
          onClick={alternar}
          className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
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
        className="mb-1.5 flex flex-wrap items-center gap-1"
      >
        {secoes
          .filter((secao) => secao.respostas.length > 0)
          .map((secao) => (
            <span
              key={secao.grupo?.id ?? "sem-grupo"}
              data-secao-de-recursos={secao.grupo?.id ?? "sem-grupo"}
              className="inline-flex flex-wrap items-center gap-1"
            >
              <span className="px-1 text-[11px] font-medium text-muted-foreground">
                {secao.grupo ? secao.grupo.name : t("Sem grupo")}
              </span>
              {secao.respostas.map((recurso) => (
                <BotaoDeRecurso
                  key={recurso.id}
                  recurso={recurso}
                  disabled={disabled}
                  dica={dica}
                  onEscolher={onEscolher}
                />
              ))}
            </span>
          ))}
        {controles}
      </div>
    );
  }

  return (
    <div
      data-testid="barra-de-recursos"
      role="toolbar"
      aria-label={t("Respostas rápidas")}
      className="mb-1.5 flex flex-wrap items-center gap-1"
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
 * O botão de UM recurso — o mesmo markup na barra plana e nas seções. Extraído
 * para a barra agrupada não divergir da plana em rótulo, `title` ou atributo de
 * teste que um e2e procura.
 */
function BotaoDeRecurso({
  recurso,
  disabled,
  dica,
  onEscolher,
}: {
  recurso: Recurso;
  disabled: boolean;
  dica?: string;
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
      className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      {rotuloDoBotao(leitura, recurso.title)}
    </button>
  );
}
