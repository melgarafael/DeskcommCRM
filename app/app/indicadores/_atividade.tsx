"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Skeleton } from "@/components/ui/skeleton";

interface AtividadeLinha {
  id: string;
  contact_id: string | null;
  contato_nome: string | null;
  tipo: string;
  resultado: string | null;
  ocorrida_em: string;
}

function quando(iso: string, tag: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(tag, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Linha temporal das atividades recentes da operação (visitas, ligações,
 * WhatsApp). Fonte: `GET /api/v1/atividades` — o que foi feito, do recente.
 */
export function Atividade() {
  const t = useT();
  const tagIdioma = useTagDeIdioma();
  const ROTULO_TIPO: Record<string, string> = {
    visita: t("Visita"),
    ligacao: t("Ligação"),
    whatsapp: "WhatsApp",
    email: t("E-mail"),
    outro: t("Atividade"),
  };
  const { data, isLoading } = useQuery({
    queryKey: ["nexus", "atividades"],
    queryFn: () =>
      apiClient.get<{ data: AtividadeLinha[] }>("/api/v1/atividades").then((r) => r.data ?? []),
    staleTime: 60_000,
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  const recentes = (data ?? []).slice(0, 8);

  return (
    <section
      aria-label={t("Atividade recente")}
      className="rounded-lg border border-border bg-surface p-4 shadow-xs"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-text">{t("Atividade recente")}</h2>
        <Link href="/app/tarefas" className="text-xs underline underline-offset-4">
          {t("Ver tarefas")}
        </Link>
      </div>
      {recentes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Nenhuma atividade registrada ainda — visitas e ligações aparecem aqui.")}
        </p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {recentes.map((a) => (
            <li key={a.id} className="flex items-start gap-2.5 text-sm">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <div className="min-w-0">
                <p className="text-text">
                  <span className="font-medium">{ROTULO_TIPO[a.tipo] ?? a.tipo}</span>
                  {a.contact_id ? (
                    <>
                      {" · "}
                      <Link
                        href={`/app/contacts/${a.contact_id}`}
                        className="underline underline-offset-4"
                      >
                        {a.contato_nome ?? "cliente"}
                      </Link>
                    </>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {a.resultado ?? "—"} · {quando(a.ocorrida_em, tagIdioma)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
