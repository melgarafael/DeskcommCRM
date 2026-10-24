"use client";

/**
 * Meta do mês e progresso no Desempenho (issue #3025, fatia 1).
 *
 * ─── Por que este painel existe ─────────────────────────────────────────────
 * A tela mostrava só o realizado. Sem ALVO não há percentual, e a comparação
 * mês a mês ficava na cabeça de quem cobra o time. Aqui estão os quatro números,
 * com a MESMA régua de barra do card de funil logo abaixo: o que muda de um
 * painel para o outro é o denominador, não o desenho.
 *
 * ─── Por que o estado chega por prop ────────────────────────────────────────
 * Quem busca é o `MetricsClient` (um pedido só para a tela). O painel recebe
 * carregando/erro/vazio/ok e por isso é medido em DOM sem banco e sem mock de
 * rede — o que precisa de prova aqui é o DESFECHO de cada estado, e o mais
 * importante deles é o VAZIO: "sem meta" é ausência de cadastro, e mostrar
 * `0 de 0` ali seria afirmar que a empresa não vendeu nada.
 *
 * ─── O caso atingido ───────────────────────────────────────────────────────
 * Percentual acima de 100 é informação (vendeu mais do que a meta), mas a barra
 * para em 100% e "quanto falta" fica ausente em vez de negativo: `-7` seria uma
 * dívida que não existe.
 */
import { useT } from "@/hooks/i18n/useT";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { mesLegivel } from "@/lib/metas/periodo";
import Link from "next/link";

export interface MetaDaEmpresa {
  id: string;
  escopo: "empresa" | "funil";
  pipeline_id: string | null;
  pipeline_nome: string | null;
  alvo: number;
  realizado: number;
  percentual: number;
  falta: number;
  atingida: boolean;
}

export type EstadoDaMeta = "carregando" | "erro" | "vazio" | "ok";

interface Props {
  estado: EstadoDaMeta;
  /** O 1º dia do mês da meta, como `YYYY-MM-01`; nulo quando não há meta. */
  periodo: string | null;
  metas: readonly MetaDaEmpresa[];
  /** manager+: mostra a porta do cadastro em Configurações. */
  podeConfigurar: boolean;
}

export function MetaDoMesPanel({ estado, periodo, metas, podeConfigurar }: Props) {
  const t = useT();
  const mes = mesLegivel(periodo);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("Meta do mês")}
          {mes ? ` · ${mes}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {estado === "carregando" ? (
          <div
            className="flex flex-col gap-2"
            aria-busy="true"
            aria-label={t("Carregando a meta do mês")}
          >
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : null}

        {estado === "erro" ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "Não consegui carregar a meta do mês — isto é uma falha de leitura, não a ausência de meta.",
            )}
          </p>
        ) : null}

        {estado === "vazio" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {t("Nenhuma meta cadastrada para este mês.")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(
                "Defina a meta em Configurações › Meta de vendas para ver aqui o quanto já foi feito e o quanto falta.",
              )}
            </p>
            {podeConfigurar ? (
              <Link
                href="/app/settings/metas"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("Definir a meta")}
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("Só quem administra a empresa define a meta.")}
              </p>
            )}
          </div>
        ) : null}

        {estado === "ok"
          ? metas.map((m) => (
              <div key={m.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm">
                    {m.escopo === "funil" ? (m.pipeline_nome ?? t("Funil")) : t("Empresa")}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">
                    <span data-meta="percentual">{m.percentual}%</span> {t("da meta")}
                  </span>
                </div>

                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    data-meta="barra"
                    className={`h-full rounded-full transition-[width] ${
                      m.atingida ? "bg-emerald-500" : "bg-primary"
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, m.percentual))}%` }}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>
                    <span className="tabular-nums" data-meta="realizado">
                      {m.realizado}
                    </span>{" "}
                    {t("de")}{" "}
                    <span className="tabular-nums" data-meta="alvo">
                      {m.alvo}
                    </span>{" "}
                    {t("Vendas ganhas")}
                  </span>
                  <span>
                    {m.atingida ? (
                      t("Meta atingida.")
                    ) : (
                      <>
                        {t("Faltam")}{" "}
                        <span className="tabular-nums" data-meta="falta">
                          {m.falta}
                        </span>{" "}
                        {t("para a meta")}
                      </>
                    )}
                  </span>
                </div>
              </div>
            ))
          : null}
      </CardContent>
    </Card>
  );
}
