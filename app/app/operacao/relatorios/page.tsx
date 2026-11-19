import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { horaCurtaNoFuso } from "@/lib/operacao/regras";
import { contextoDaOrganizacao, TABELA_DOS_RELATORIOS } from "@/lib/operacao/relatorio-diario";
import type { ContagemPorCanal } from "@/lib/operacao/tipos";
import { createClient } from "@/lib/supabase/server";

import { ConfiguracaoDaOperacao } from "./_components/ConfiguracaoDaOperacao";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Relatórios do dia" };

/**
 * Os relatórios diários salvos (manager+, a mesma régua da RLS da tabela: o
 * relatório reúne as conversas da equipe inteira). Um por dia, o mais novo em
 * cima; o administrador ajusta aqui as etiquetas e a hora do relatório.
 */
export default async function RelatoriosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  const t = (texto: string) => traduzir(texto, user.idioma);

  const db = await createClient();
  const ctx = await contextoDaOrganizacao(db, activeOrg.orgId);
  const { data, error } = await db
    .from(TABELA_DOS_RELATORIOS)
    .select("id, dia, gerado_em, gerado_por, novas:conteudo->contadores->novas, com_entrada:conteudo->contadores->com_entrada")
    .eq("organization_id", activeOrg.orgId)
    .order("dia", { ascending: false })
    .limit(120);
  const linhas = (data ?? []) as unknown as Array<{
    id: string;
    dia: string;
    gerado_em: string;
    gerado_por: "cron" | "usuario";
    novas: ContagemPorCanal | null;
    com_entrada: ContagemPorCanal | null;
  }>;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Relatórios do dia")}</h1>
          <p className="text-sm text-text-muted">
            {t("Um relatório por dia, salvo automaticamente na hora marcada. Abra um dia para ver quem foi atendido, o que foi pedido e o que ficou pendente.")}
          </p>
        </div>
        <Link href="/app/operacao" className="h-9 rounded-md border border-border px-3 text-sm leading-9">
          {t("Operação do dia")}
        </Link>
      </header>

      {error && <p className="text-sm text-red-500">{t("Não deu para carregar os relatórios agora.")}</p>}

      <section className="rounded-lg border border-border bg-surface">
        {linhas.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-text-muted">
            {t("Nenhum relatório salvo ainda. O primeiro sai sozinho na hora marcada, ou pelo botão Gerar relatório agora.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" data-testid="relatorios-lista">
              <thead className="text-left text-xs text-text-muted">
                <tr className="border-b border-border">
                  <th className="px-3 py-2 font-medium">{t("Dia")}</th>
                  <th className="px-3 py-2 font-medium">{t("Gerado às")}</th>
                  <th className="px-3 py-2 font-medium">{t("Origem")}</th>
                  <th className="px-3 py-2 font-medium">{t("Conversas novas")}</th>
                  <th className="px-3 py-2 font-medium">{t("Com mensagem do cliente")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {linhas.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      <Link href={`/app/operacao/relatorios/${l.dia}`} className="font-medium text-primary hover:underline">
                        {l.dia}
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{horaCurtaNoFuso(l.gerado_em, ctx.fuso)}</td>
                    <td className="px-3 py-2 text-xs">{l.gerado_por === "cron" ? t("Automático") : t("Gerado por uma pessoa")}</td>
                    <td className="px-3 py-2 tabular-nums">{l.novas?.total ?? t("não registrado")}</td>
                    <td className="px-3 py-2 tabular-nums">{l.com_entrada?.total ?? t("não registrado")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin && <ConfiguracaoDaOperacao inicial={ctx.config} />}
    </div>
  );
}
