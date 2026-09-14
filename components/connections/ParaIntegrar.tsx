"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import { Info } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

export interface CampoDeIntegracao {
  /** Rótulo já traduzido pelo chamador (`t(...)`). */
  rotulo: string;
  valor: string | null;
}

/**
 * "Para integrar" — os dados NÃO-secretos de uma conexão, prontos para colar em
 * outro sistema que vá falar com o mesmo número.
 *
 * ─── Por que o token NÃO aparece aqui ───────────────────────────────────────
 *
 * Nenhuma credencial volta do servidor depois de gravada (o GET devolve só
 * `hasToken`). Em vez de abrir uma exceção para exibi-la, o ícone ao lado diz
 * ONDE obtê-la no painel do provedor — o operador a tem lá, e o CRM não precisa
 * carregar o risco de devolver segredo de volta.
 */
export function ParaIntegrar({
  campos,
  ajuda,
  aviso,
}: {
  campos: CampoDeIntegracao[];
  /** Conteúdo da caixinha de ajuda (hover no ícone). */
  ajuda: ReactNode;
  /** Aviso opcional para o caso de webhook (mostrado abaixo dos dados). */
  aviso?: ReactNode;
}) {
  const t = useT();
  const preenchidos = campos.filter((c): c is { rotulo: string; valor: string } => Boolean(c.valor));

  const copiar = async () => {
    const texto = preenchidos.map((c) => `${c.rotulo}: ${c.valor}`).join("\n");
    if (await copyToClipboard(texto)) toast.success(t("Copiado."));
    else toast.error(t("Não foi possível copiar."));
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="para-integrar">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("Para integrar")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "Estes dados conectam outro sistema ao mesmo número. O token não aparece aqui — o ícone ao lado diz onde obtê-lo no painel do provedor.",
            )}
          </p>
        </div>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={t("Onde obter o token")}
              >
                <Info size={18} aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs space-y-2 text-wrap">{ajuda}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <dl className="flex flex-col gap-2">
        {preenchidos.map((c, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {c.rotulo}
            </dt>
            <dd className="break-all font-mono text-xs">{c.valor}</dd>
          </div>
        ))}
      </dl>

      {aviso ? (
        <p className="rounded-md border border-warning/40 bg-warning-bg p-2 text-xs text-warning-fg">
          {aviso}
        </p>
      ) : null}

      <div>
        {preenchidos.length > 0 ? (
          <Button size="sm" variant="outline" onClick={copiar}>
            {t("Copiar dados")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
