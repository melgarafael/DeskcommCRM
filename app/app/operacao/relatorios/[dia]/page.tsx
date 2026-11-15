import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SecoesDaOperacao } from "@/components/operacao/SecoesDaOperacao";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { idsDeContatoDoConteudo, lerConteudo, sobreporAnonimizados } from "@/lib/operacao/conteudo";
import { diaValido, horaCurtaNoFuso } from "@/lib/operacao/regras";
import { TABELA_DOS_RELATORIOS } from "@/lib/operacao/relatorio-diario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Relatório do dia" };

/**
 * Um relatório diário salvo, desenhado pelo MESMO componente da tela ao vivo,
 * com a espera medida contra a hora em que ele foi gerado. Os links abrem a
 * conversa no Inbox. Contato anonimizado depois da geração aparece anonimizado.
 */
export default async function RelatorioDoDiaPage({ params }: { params: Promise<{ dia: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  const { dia } = await params;
  if (!diaValido(dia)) notFound();
  const t = (texto: string) => traduzir(texto, user.idioma);

  const db = await createClient();
  const { data } = await db
    .from(TABELA_DOS_RELATORIOS)
    .select("dia, fuso, gerado_em, gerado_por, conteudo, texto")
    .eq("organization_id", activeOrg.orgId)
    .eq("dia", dia)
    .maybeSingle();
  if (!data) notFound();
  const linha = data as { dia: string; fuso: string; gerado_em: string; gerado_por: string; conteudo: unknown; texto: string };
  let conteudo = lerConteudo(linha.conteudo);

  if (conteudo) {
    const ids = idsDeContatoDoConteudo(conteudo);
    const anonimizados: Array<{ id: string; nome: string | null }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: contatos } = await db
        .from("contacts")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .eq("is_anonymized", true)
        .in("id", ids.slice(i, i + 200));
      for (const c of (contatos ?? []) as Array<{ id: string; name: string | null }>) anonimizados.push({ id: c.id, nome: c.name });
    }
    conteudo = sobreporAnonimizados(conteudo, anonimizados);
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("Relatório do dia")} {linha.dia}
          </h1>
          <p className="text-sm text-text-muted">
            {t("Gerado às")} {horaCurtaNoFuso(linha.gerado_em, linha.fuso)} ({linha.fuso}) ·{" "}
            {linha.gerado_por === "cron" ? t("Automático") : t("Gerado por uma pessoa")}
          </p>
        </div>
        <Link href="/app/operacao/relatorios" className="h-9 rounded-md border border-border px-3 text-sm leading-9">
          {t("Relatórios salvos")}
        </Link>
      </header>
      {conteudo ? (
        <SecoesDaOperacao operacao={conteudo} referencia={linha.gerado_em} />
      ) : (
        <p className="text-sm text-text-muted">{t("Este relatório foi salvo num formato que esta versão não sabe desenhar. O texto abaixo continua valendo.")}</p>
      )}
      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">{t("Texto do relatório")}</summary>
        <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{linha.texto}</pre>
      </details>
    </div>
  );
}
