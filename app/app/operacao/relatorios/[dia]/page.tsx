import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SecoesDaOperacao } from "@/components/operacao/SecoesDaOperacao";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { hidratar, lerConteudo } from "@/lib/operacao/conteudo";
import { leitorDoBanco } from "@/lib/operacao/hidratar-do-banco";
import { nomesPelaFuncao } from "@/lib/operacao/operacao-do-dia";
import { diaValido, horaCurtaNoFuso } from "@/lib/operacao/regras";
import { contextoDaOrganizacao, TABELA_DOS_RELATORIOS, urlPublicaDoApp } from "@/lib/operacao/relatorio-diario";
import { textoDoRelatorio } from "@/lib/operacao/texto-do-relatorio";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Relatório do dia" };

/**
 * Um relatório diário salvo, desenhado pelo MESMO componente da tela ao vivo,
 * com a espera medida contra a hora em que ele foi gerado.
 *
 * O banco guarda só fatos (`congelar`). Nome, telefone, @, resumo, título da
 * tarefa e do negócio são lidos AGORA (`hidratar` + `leitorDoBanco`), pelo
 * client da sessão: um contato anonimizado depois da geração aparece
 * anonimizado, e o texto do relatório é montado aqui com o mesmo conteúdo.
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
  const { data, error } = await db
    .from(TABELA_DOS_RELATORIOS)
    .select("dia, fuso, gerado_em, gerado_por, conteudo")
    .eq("organization_id", activeOrg.orgId)
    .eq("dia", dia)
    .maybeSingle();
  // Falha de banco não é "relatório não existe": lança, e a tela de erro diz que a leitura falhou.
  if (error) throw new Error(`relatório do dia não lido: ${error.message}`);
  if (!data) notFound();
  const linha = data as { dia: string; fuso: string; gerado_em: string; gerado_por: string; conteudo: unknown };
  const guardado = lerConteudo(linha.conteudo);
  const conteudo = guardado
    ? await hidratar(
        guardado,
        leitorDoBanco(db, activeOrg.orgId, nomesPelaFuncao(createAdminClient(), activeOrg.orgId)),
      )
    : null;
  const ctx = await contextoDaOrganizacao(db, activeOrg.orgId);
  const texto = conteudo
    ? textoDoRelatorio(conteudo, { idioma: ctx.idioma, baseUrl: urlPublicaDoApp(), geradoEm: new Date(linha.gerado_em) })
    : null;

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
        <SecoesDaOperacao operacao={conteudo} referencia={linha.gerado_em} modo="relatorio" />
      ) : (
        <p className="text-sm text-text-muted">{t("Este relatório foi salvo num formato que esta versão não sabe desenhar.")}</p>
      )}
      {texto && (
        <details className="rounded-lg border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-semibold">{t("Texto do relatório")}</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs" data-testid="relatorio-texto">
            {texto}
          </pre>
        </details>
      )}
    </div>
  );
}
