import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { Relatorios } from "./_components/Relatorios";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Atividades" };

/**
 * As duas abas são endereçáveis, como em `/app/team`: quem mandar o link da
 * aba Por etiqueta (`?aba=etiquetas`) abre nela. Valor desconhecido cai na aba
 * de sempre em vez de deixar as duas fechadas.
 *
 * `aba` em português porque é o que aparece na barra de endereço de quem usa
 * o produto — a mesma convenção do time e das telas de settings.
 */
const ABAS: Record<string, string> = { atividades: "atividades", etiquetas: "etiquetas" };

export default async function ActivitiesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string }>;
}) {
  const user = await requireAuth();
  // `t` local e não o hook: componente de SERVIDOR — o idioma já vem resolvido
  // pela cadeia pessoa → organização → padrão em `lib/auth/server.ts`.
  const t = (texto: string) => traduzir(texto, user.idioma);
  const { aba } = await searchParams;
  const abaInicial = ABAS[aba ?? ""] ?? "atividades";

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Atividades")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que aconteceu na operação no período — e quanto disso foi a equipe.")}
        </p>
      </header>

      <Relatorios abaInicial={abaInicial} />
    </div>
  );
}
