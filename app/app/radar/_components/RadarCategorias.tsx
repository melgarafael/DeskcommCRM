"use client";
import Link from "next/link";
import * as React from "react";

import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { ROTULO_RECOMPRA, type SituacaoRecompra } from "@/lib/comercial/radar-compras";
import type { LinhaRadar } from "@/lib/comercial/radar-score";
import type { AtRiskData } from "@/hooks/leads/useAtRiskLeads";

type CategoriaId = "risco" | "recompra" | "oportunidade" | "followup" | "perda" | "cobranca";

const CATEGORIAS: { id: CategoriaId; cor: string }[] = [
  { id: "risco", cor: "var(--color-ember)" },
  { id: "recompra", cor: "var(--color-amber)" },
  { id: "oportunidade", cor: "var(--color-sky)" },
  { id: "followup", cor: "var(--color-iris)" },
  { id: "perda", cor: "var(--color-text-subtle)" },
  { id: "cobranca", cor: "var(--color-magenta)" },
];

interface TituloVencido {
  contact_id: string | null;
  contato_nome: string | null;
  saldo_cents: number;
  vencimento: string;
  situacao: string;
}

function motivoDe(l: LinhaRadar, t: (texto: string) => string): string {
  if (l.intervalo_mediano_dias != null) {
    return `${t("há")} ${l.dias_sem_compra}d ${t("sem comprar")}; ${t("padrão a cada")} ~${Math.round(l.intervalo_mediano_dias)}d (+${l.atraso_dias}d)`;
  }
  return `${t("há")} ${l.dias_sem_compra}d ${t("sem comprar")}`;
}

/**
 * Board de categorias do Radar: RISCO · RECOMPRA · OPORTUNIDADE · FOLLOW-UP ·
 * PERDA · COBRANÇA. Cada item traz motivo, dados, valor potencial, última
 * compra, próxima ação e responsável — tudo derivado das leituras reais
 * (radar, at-risk, recebíveis). Ações rápidas sem sair da tela.
 */
export function RadarCategorias({
  linhas,
  nomesVendedores,
  risco,
  montarZap,
  onCriarTarefa,
  tarefaEmCurso,
}: {
  linhas: LinhaRadar[];
  nomesVendedores: Map<string, string>;
  risco: AtRiskData | undefined;
  montarZap: (
    fone: string | null,
    nome: string,
    atraso: number,
    intervalo: number | null,
  ) => string | null;
  onCriarTarefa: (l: LinhaRadar) => void;
  tarefaEmCurso: string | null;
}) {
  const t = useT();
  const ROTULO_CATEGORIA: Record<CategoriaId, string> = {
    risco: t("Risco"),
    recompra: t("Recompra"),
    oportunidade: t("Oportunidade"),
    followup: t("Follow-up"),
    perda: t("Perda"),
    cobranca: t("Cobrança"),
  };
  const [categoria, setCategoria] = React.useState<CategoriaId>("risco");
  const [titulos, setTitulos] = React.useState<TituloVencido[] | null>(null);

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: TituloVencido[] }>("/api/v1/financeiro/recebiveis?limit=500")
      .then((r) => {
        if (!vivo) return;
        setTitulos(
          (r.data ?? [])
            .filter((x) => x.situacao === "vencido")
            .sort((a, b) => b.saldo_cents - a.saldo_cents)
            .slice(0, 8),
        );
      })
      .catch(() => vivo && setTitulos([]));
    return () => {
      vivo = false;
    };
  }, []);

  const porSituacao = React.useMemo(() => {
    const mapa = new Map<SituacaoRecompra, LinhaRadar[]>();
    for (const l of linhas) {
      const lista = mapa.get(l.situacao) ?? [];
      lista.push(l);
      mapa.set(l.situacao, lista);
    }
    return mapa;
  }, [linhas]);

  const grupos = React.useMemo(() => {
    const emRisco = porSituacao.get("em_risco") ?? [];
    const recompra = porSituacao.get("recompra_atrasada") ?? [];
    const oportunidade = [
      ...(porSituacao.get("oportunidade_aberta") ?? []),
      ...(porSituacao.get("em_voo") ?? []),
      ...(porSituacao.get("primeira_compra") ?? []),
    ];
    const perda = porSituacao.get("cancelado_sem_nova") ?? [];
    return { emRisco, recompra, oportunidade, perda };
  }, [porSituacao]);

  interface ItemFollowup {
    id: string;
    titulo: string;
    detalhe: string;
    href: string | null;
    hrefRotulo: string;
  }

  const followups = React.useMemo<ItemFollowup[]>(() => {
    if (!risco) return [];
    const itens: ItemFollowup[] = risco.items.map((l) => ({
      id: `lead:${l.id}`,
      titulo: l.title,
      detalhe:
        l.hours_since_activity != null
          ? `${t("parado há")} ${l.hours_since_activity}h`
          : t("sem atividade recente"),
      href: `/app/leads/${l.id}`,
      hrefRotulo: t("abrir negócio"),
    }));
    for (const d of risco.sem_proximo_passo) {
      itens.push({
        id: `demanda:${d.id}`,
        titulo: d.contact_name ?? t("Demanda sem próximo passo"),
        detalhe: `${t("aberta em")} ${d.aberta_em.slice(0, 10).split("-").reverse().join("/")}`,
        href: d.contact_id ? `/app/contacts/${d.contact_id}` : null,
        hrefRotulo: t("abrir cliente"),
      });
    }
    return itens.slice(0, 8);
  }, [risco, t]);

  const contagens: Record<CategoriaId, number | null> = {
    risco: grupos.emRisco.length,
    recompra: grupos.recompra.length,
    oportunidade: grupos.oportunidade.length,
    followup: risco ? followups.length : null,
    perda: grupos.perda.length,
    cobranca: titulos ? titulos.length : null,
  };

  function CartaoRadar({ l }: { l: LinhaRadar }) {
    const zap = montarZap(l.fone, l.nome, l.atraso_dias, l.intervalo_mediano_dias);
    const vendedor = l.vendedor_user_id ? (nomesVendedores.get(l.vendedor_user_id) ?? null) : null;
    return (
      <li className="rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/app/contacts/${l.contact_id}`}
            className="font-medium text-text underline-offset-4 hover:underline"
          >
            {l.nome}
          </Link>
          <Badge variant="warning">{ROTULO_RECOMPRA[l.situacao]}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{motivoDe(l, t)}</p>
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          {t("última")} {l.ultima_compra.split("-").reverse().join("/")} · {t("ticket")}{" "}
          {comoMoeda(l.ticket_medio_cents, "BRL")} · {t("potencial")}{" "}
          {comoMoeda(l.ticket_medio_cents, "BRL")}
          {vendedor ? ` · ${t("resp.")} ${vendedor}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {zap && (
            <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
              <a href={zap} target="_blank" rel="noopener noreferrer">
                WhatsApp
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={tarefaEmCurso === l.contact_id}
            onClick={() => onCriarTarefa(l)}
          >
            {tarefaEmCurso === l.contact_id ? t("Criando…") : t("Criar tarefa")}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <Card className="p-4">
      <h2 className="text-base font-medium text-text">{t("Radar por categoria")}</h2>
      <p className="text-xs text-muted-foreground">
        {t("Risco, recompra, oportunidade, follow-up, perda e cobrança — com próxima ação.")}
      </p>
      <div
        className="mt-3 flex gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t("Categorias")}
      >
        {CATEGORIAS.map((c) => {
          const qtd = contagens[c.id];
          const ativa = categoria === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={ativa}
              onClick={() => setCategoria(c.id)}
              className={`nexus-transition flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                ativa
                  ? "border-transparent bg-accent text-accent-foreground"
                  : "hover:border-accent"
              }`}
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.cor }}
              />
              {ROTULO_CATEGORIA[c.id]}
              <span className="tabular-nums">{qtd === null ? "…" : qtd}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {(categoria === "risco" ||
          categoria === "recompra" ||
          categoria === "oportunidade" ||
          categoria === "perda") &&
          (() => {
            const lista =
              categoria === "risco"
                ? grupos.emRisco
                : categoria === "recompra"
                  ? grupos.recompra
                  : categoria === "oportunidade"
                    ? grupos.oportunidade
                    : grupos.perda;
            if (lista.length === 0) {
              return (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t("Ninguém nesta categoria agora.")}
                </p>
              );
            }
            return (
              <ul className="grid gap-2 md:grid-cols-2">
                {lista.slice(0, 8).map((l) => (
                  <CartaoRadar key={l.contact_id} l={l} />
                ))}
              </ul>
            );
          })()}

        {categoria === "followup" &&
          (risco === undefined ? (
            <Skeleton className="h-20 w-full" />
          ) : followups.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("Nenhum follow-up pendente.")}
            </p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {followups.map((f) => (
                <li key={f.id} className="rounded-lg border border-border bg-surface p-3">
                  <p className="truncate text-sm font-medium text-text">{f.titulo}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {f.detalhe}
                    {f.href ? (
                      <>
                        {" · "}
                        <Link href={f.href} className="underline underline-offset-4">
                          {f.hrefRotulo}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          ))}

        {categoria === "cobranca" &&
          (titulos === null ? (
            <Skeleton className="h-20 w-full" />
          ) : titulos.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("Nenhum título vencido.")}
            </p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {titulos.map((x, i) => (
                <li
                  key={`${x.contact_id ?? "s/c"}-${i}`}
                  className="rounded-lg border border-border bg-surface p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {x.contact_id ? (
                      <Link
                        href={`/app/contacts/${x.contact_id}`}
                        className="font-medium text-text underline-offset-4 hover:underline"
                      >
                        {x.contato_nome ?? t("Cliente")}
                      </Link>
                    ) : (
                      <span className="font-medium text-text">
                        {x.contato_nome ?? t("Sem cliente")}
                      </span>
                    )}
                    <Badge variant="error">{t("vencido")}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {comoMoeda(x.saldo_cents, "BRL")} · {t("vence(u)")}{" "}
                    {x.vencimento.split("-").reverse().join("/")}
                  </p>
                  <div className="mt-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                      <Link href="/app/financeiro">{t("Cobrar no financeiro")}</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Card>
  );
}
