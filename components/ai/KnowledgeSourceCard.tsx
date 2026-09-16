"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";
/**
 * UM MATERIAL DO ACERVO.
 *
 * Antes isto era um "slot": quatro cartões fixos, um por categoria, presos ao
 * agente padrão da organização. Dois dos quatro botões eram decorativos —
 * "Editar conteúdo" e "Upload novo arquivo" abriam um `toast.info("em breve")`
 * sobre uma API que já existia e nunca foi ligada à tela.
 *
 * Agora cada cartão é um material de verdade, com as ações que ele aceita: ver
 * o que o agente aprendeu, editar (quando é texto colado), preparar de novo, e
 * arquivar. O que o cartão NÃO oferece é o que aquele tipo de material não
 * aceita — controle que não controla nada gasta a confiança de quem clicou.
 */
import { useState } from "react";
import {
  BookOpen,
  FileText,
  HelpCircle,
  MessageSquare,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SourceStatusBadge, deriveBadgeStatus } from "@/components/ai/SourceStatusBadge";
import { TrechosDoMaterialDialog } from "@/components/ai/TrechosDoMaterialDialog";
import { EditarFaqDialog } from "@/components/ai/EditarFaqDialog";
import {
  TIPO_DE_FONTE_POR_ID,
  canonizarTipoDeFonte,
  aceitaTextoColado,
} from "@/lib/ai/rag/tipos-de-fonte";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";

const ICONE_POR_TIPO: Record<string, typeof HelpCircle> = {
  faq: HelpCircle,
  documento: FileText,
  conversas: MessageSquare,
  catalogo: Package,
};

interface Props {
  source: SourceRow;
  /** Nomes dos assistentes que consultam este material. */
  usadoPor: string[];
  onReindex: () => void;
  onArquivar: () => void;
  onMudou: () => void;
  isReindexing?: boolean;
}

function formatRelative(
  iso: string | null,
  tagDoIdioma: string,
  t: (texto: string) => string = (texto) => texto,
): string {
  if (!iso) return t("nunca");
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return t("agora há pouco");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `há ${diffHr} h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `há ${diffDay} d`;
  return new Date(iso).toLocaleDateString(tagDoIdioma);
}

export function KnowledgeSourceCard({
  source,
  usadoPor,
  onReindex,
  onArquivar,
  onMudou,
  isReindexing,
}: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [vendoTrechos, setVendoTrechos] = useState(false);
  const [editando, setEditando] = useState(false);

  const tipo = canonizarTipoDeFonte(source.source_type) ?? "faq";
  const meta = TIPO_DE_FONTE_POR_ID.get(tipo);
  const Icon = ICONE_POR_TIPO[tipo] ?? BookOpen;

  const derived = deriveBadgeStatus(source);
  const arquivado = derived === "archived";
  const mostraErro =
    (derived === "failed" || derived === "sem_credencial") && source.last_index_error;
  const temTrechos = (source.chunks_count ?? 0) > 0;

  return (
    <Card className="flex h-full flex-col" data-testid={`material-${source.id}`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 shrink-0 text-accent" aria-hidden />
            <CardTitle className="text-base">{source.name}</CardTitle>
          </div>
          <SourceStatusBadge source={source} />
        </div>
        <p className="text-sm text-text-muted">
          {meta?.rotulo ? t(meta.rotulo) : source.source_type}
        </p>
      </CardHeader>

      <CardContent className="flex-1 space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-text-muted">{t("Preparado")}</span>
          <span>{formatRelative(source.last_indexed_at, tagDoIdioma, t)}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-text-muted">{t("Trechos que o agente encontra")}</span>
          <span data-testid={`material-trechos-${source.id}`}>{source.chunks_count ?? 0}</span>
        </div>

        {/* Quem usa este material. Sem isto, arquivar é um tiro no escuro: não dá
            para saber quantos assistentes param de saber daquilo. */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-text-muted">{t("Consultado por")}</span>
          <span className="text-right">
            {usadoPor.length === 0 ? (
              <span className="text-warning-fg" data-testid={`material-orfao-${source.id}`}>
                {t("nenhum assistente ainda")}
              </span>
            ) : (
              usadoPor.join(", ")
            )}
          </span>
        </div>

        {mostraErro ? (
          <details className="rounded-md border border-error-bg bg-error-bg/30 p-2 text-xs text-error-fg">
            <summary className="cursor-pointer font-medium">{t("Por que não entrou")}</summary>
            <p className="mt-1 whitespace-pre-wrap break-words">{source.last_index_error}</p>
          </details>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={arquivado || isReindexing}
          onClick={onReindex}
          data-testid={`material-reindexar-${source.id}`}
        >
          <RefreshCw
            className={`mr-2 h-3.5 w-3.5 ${isReindexing ? "animate-spin" : ""}`}
            aria-hidden
          />
          {isReindexing ? t("Preparando…") : t("Preparar de novo")}
        </Button>

        {temTrechos ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVendoTrechos(true)}
              data-testid={`material-ver-${source.id}`}
            >
              {t("Ver o que ele aprendeu")}
            </Button>
            {/* Montado só quando aberto: o diálogo faz `useQuery`, e mantê-lo
                no ar fechado custa um observer por cartão numa tela que lista
                dezenas deles. */}
            {vendoTrechos ? (
              <TrechosDoMaterialDialog
                sourceId={source.id}
                nome={source.name}
                aberto
                onFechar={() => setVendoTrechos(false)}
              />
            ) : null}
          </>
        ) : null}

        {aceitaTextoColado(tipo) && !arquivado ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditando(true)}
              data-testid={`material-editar-${source.id}`}
            >
              {t("Editar conteúdo")}
            </Button>
            {editando ? (
              <EditarFaqDialog
                sourceId={source.id}
                nome={source.name}
                aberto
                onFechar={() => setEditando(false)}
                onSalvo={onMudou}
              />
            ) : null}
          </>
        ) : null}

        {!arquivado ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onArquivar}
            data-testid={`material-arquivar-${source.id}`}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden />
            {t("Arquivar")}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
