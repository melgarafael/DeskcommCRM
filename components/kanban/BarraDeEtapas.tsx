"use client";

import { useEffect, useRef } from "react";

import { useT } from "@/hooks/i18n/useT";
import {
  montarBarraDeEtapas,
  type EstadoDaEtapaNaBarra,
  type EtapaDaBarra,
} from "@/lib/kanban/barra-de-etapas";

/**
 * A BARRA DE ETAPAS no topo do negócio: as etapas abertas do funil como setas
 * lado a lado, a atual em destaque com "Nome (N dias)", as anteriores como
 * percorridas e as seguintes neutras. A regra mora em
 * `lib/kanban/barra-de-etapas.ts`; aqui só o desenho.
 *
 * ─── Convive com o seletor `EtapaNoDossie`, não o substitui ─────────────────
 *
 * A barra mostra o CAMINHO e deixa pular para uma etapa aberta com um clique; o
 * seletor continua sendo o controle completo — é ele que lista também ganho e
 * perda, que a barra deixa de fora de propósito. Tirar o seletor apagaria do
 * dossiê o único caminho para um desfecho.
 *
 * ─── Quem move é QUEM CHAMA ─────────────────────────────────────────────────
 *
 * O clique chama `onMudar(stageId)` — o MESMO fio do seletor. No quadro ele
 * desemboca no "Mover para…" do card (campos obrigatórios, trava de
 * `updated_at`, topo da etapa); na página inteira, no `mudarEtapa` dela. Nenhuma
 * regra de movimento é decidida aqui. Sem permissão de mover, as setas são
 * texto: um botão que recusa no clique seria pior que nenhum.
 *
 * ─── Tela estreita e funil comprido ─────────────────────────────────────────
 *
 * O painel tem 28rem até no desktop. A lista não quebra linha: rola na
 * horizontal dentro da própria faixa, os nomes das etapas não atuais são
 * cortados com reticências (o nome inteiro fica no `title`), e ao abrir (e ao
 * mudar de largura) a faixa centraliza a etapa atual. Leitor de tela ouve
 * "Etapa N de M" antes da lista.
 */

/** O recorte de seta, feito por `clip-path` num fundo À PARTE: o anel de foco
 *  fica no botão, retangular, e não é cortado junto com a seta. */
const SETA_PRIMEIRA = "polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%)";
const SETA = "polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%)";

const FUNDO: Record<EstadoDaEtapaNaBarra, string> = {
  anterior: "bg-accent-soft",
  atual: "bg-accent",
  seguinte: "bg-surface-elevated",
};

const TEXTO: Record<EstadoDaEtapaNaBarra, string> = {
  anterior: "text-accent",
  atual: "font-medium text-accent-foreground",
  seguinte: "text-text-muted",
};

export function BarraDeEtapas({
  etapaAtual,
  etapas,
  podeMover,
  onMudar,
  dias,
}: {
  etapaAtual: string;
  etapas: readonly EtapaDaBarra[];
  podeMover: boolean;
  onMudar?: (stageId: string) => void;
  /** Dias inteiros na etapa atual (`diasNaEtapa`); `null` = sem a data, só o nome. */
  dias: number | null;
}) {
  const t = useT();
  const faixa = useRef<HTMLOListElement | null>(null);
  const atual = useRef<HTMLLIElement | null>(null);
  const barra = montarBarraDeEtapas(etapas, etapaAtual);

  // Centraliza a etapa atual na faixa, SÓ na horizontal: `scrollIntoView`
  // rolaria também o painel inteiro, e o cabeçalho pularia. A conta é pelas
  // caixas na tela, não por `offsetLeft`: este é relativo ao ancestral
  // posicionado (a gaveta), não à faixa, e deixava a etapa fora do centro.
  // Refaz quando a faixa muda de largura (painel redimensionado).
  useEffect(() => {
    const lista = faixa.current;
    const item = atual.current;
    if (!lista || !item) return;
    const centralizar = () => {
      if (lista.scrollWidth <= lista.clientWidth) return;
      const caixaDaLista = lista.getBoundingClientRect();
      const caixaDoItem = item.getBoundingClientRect();
      const centroDaLista = caixaDaLista.left + lista.clientLeft + lista.clientWidth / 2;
      const centroDoItem = caixaDoItem.left + caixaDoItem.width / 2;
      lista.scrollLeft = Math.max(0, lista.scrollLeft + centroDoItem - centroDaLista);
    };
    centralizar();
    if (typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver(centralizar);
    observador.observe(lista);
    return () => observador.disconnect();
  }, [etapaAtual, barra?.total]);

  if (!barra) return null;

  const clicavel = podeMover && typeof onMudar === "function";
  const textoDosDias =
    dias === null ? null : dias === 1 ? t("1 dia") : t("{n} dias").replace("{n}", String(dias));

  return (
    <nav aria-label={t("Etapas do funil")} className="w-full min-w-0" data-testid="barra-de-etapas">
      <p className="sr-only" data-testid="barra-de-etapas-posicao">
        {t("Etapa {atual} de {total}")
          .replace("{atual}", String(barra.posicaoAtual))
          .replace("{total}", String(barra.total))}
      </p>
      <ol
        ref={faixa}
        className="flex w-full min-w-0 items-stretch gap-0.5 overflow-x-auto pb-1 [scrollbar-width:thin]"
      >
        {barra.passos.map((passo, i) => {
          const ehAtual = passo.estado === "atual";
          const rotulo = ehAtual && textoDosDias ? `${passo.nome} (${textoDosDias})` : passo.nome;
          const conteudo = (
            <>
              <span
                aria-hidden
                className={`absolute inset-0 transition-colors duration-150 ${FUNDO[passo.estado]} ${
                  clicavel && !ehAtual ? "group-hover:bg-border" : ""
                }`}
                style={{ clipPath: i === 0 ? SETA_PRIMEIRA : SETA }}
              />
              <span
                className={`relative block whitespace-nowrap ${ehAtual ? "" : "max-w-[8rem] truncate"} ${
                  TEXTO[passo.estado]
                }`}
              >
                {passo.estado === "anterior" && <span className="sr-only">{`${t("concluída")}: `}</span>}
                {rotulo}
              </span>
            </>
          );
          const caixa = `group relative flex h-7 items-center text-xs ${i === 0 ? "pl-3" : "pl-4"} pr-4`;

          return (
            <li
              key={passo.id}
              ref={ehAtual ? atual : undefined}
              className="flex shrink-0"
              data-estado={passo.estado}
              aria-current={ehAtual ? "step" : undefined}
            >
              {clicavel && !ehAtual ? (
                <button
                  type="button"
                  title={passo.nome}
                  onClick={() => onMudar(passo.id)}
                  className={`${caixa} cursor-pointer rounded-xs focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-hidden`}
                  data-testid={`barra-de-etapas-${passo.id}`}
                >
                  {conteudo}
                </button>
              ) : (
                <span className={caixa} title={passo.nome} data-testid={`barra-de-etapas-${passo.id}`}>
                  {conteudo}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
