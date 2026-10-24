"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { ehRecursoDeAudio, recursosDaBarra, type Recurso } from "@/lib/inbox/recursos";
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
 */
interface Props {
  recursos: Recurso[];
  onEscolher: (recurso: Recurso) => void;
  disabled?: boolean;
  /** O usuário logado — a memória do recolhimento é POR usuário (#3282). */
  usuarioId?: string | null;
  /**
   * Injeção do armazenamento, só para teste. `undefined` (o caso de produção)
   * resolve o `localStorage` do navegador; `null` é "sem memória".
   */
  storage?: StorageLeve | null;
}

export function BarraDeRecursos({
  recursos,
  onEscolher,
  disabled = false,
  usuarioId = null,
  storage,
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

  return (
    <div
      data-testid="barra-de-recursos"
      role="toolbar"
      aria-label={t("Respostas rápidas")}
      className="mb-1.5 flex flex-wrap items-center gap-1"
    >
      {visiveis.map((recurso) => (
        <button
          key={recurso.id}
          type="button"
          disabled={disabled}
          data-recurso-id={recurso.id}
          data-recurso-tipo={ehRecursoDeAudio(recurso) ? "audio" : "texto"}
          onClick={() => onEscolher(recurso)}
          title={t("Prepara no compositor — você revisa e envia")}
          className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {ehRecursoDeAudio(recurso) ? `🎧 ${recurso.title}` : recurso.title}
        </button>
      ))}
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
    </div>
  );
}
