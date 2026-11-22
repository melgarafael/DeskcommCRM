import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerOperacaoDaSessao } from "@/lib/operacao/ler-para-a-sessao";

import { OperacaoDoDiaClient } from "./_components/OperacaoDoDiaClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Operação do dia" };

/**
 * OPERAÇÃO DO DIA — quem chegou, quem espera uma pessoa, o que foi pedido e o
 * que falhou, no dia do fuso da organização. Viewer ou acima (a mesma porta de
 * Desempenho); o recorte de cada um é o da RLS — quem só vê as próprias
 * conversas vê só as próprias aqui. O primeiro desenho vem do servidor; a tela
 * se atualiza sozinha a cada 30 s pela rota `GET /api/v1/operacao/dia`.
 */
export default async function OperacaoPage({ searchParams }: { searchParams: Promise<{ dia?: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const { dia } = await searchParams;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const r = await lerOperacaoDaSessao(activeOrg.orgId, dia ?? null);
  if (!r.ok) redirect("/app/operacao");

  const podeGerar = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Operação do dia")}</h1>
        <p className="text-sm text-text-muted">
          {t("Quem chegou, quem espera uma pessoa, o que foi pedido e o que falhou — no fuso da empresa.")}
        </p>
      </header>
      <OperacaoDoDiaClient inicial={r.operacao} hoje={r.hoje} podeGerar={podeGerar} />
    </div>
  );
}
