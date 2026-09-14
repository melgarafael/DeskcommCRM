import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { Faturamento } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O FATURAMENTO — a terceira ponta do módulo financeiro.
 *
 * Configurações › Financeiro descreve para onde o dinheiro vai. CRM › Comandas é
 * onde o dia acontece. Esta tela responde "quanto entrou, de que forma, e quanto
 * cada pessoa tem a receber" — a pergunta que se faz no fim do mês, e a razão de
 * ela ficar em Análise.
 *
 * `viewer` porque conferir o faturamento não é privilégio de quem lança. O que a
 * RLS impede é ele ver o de outra organização.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Faturamento")}</h1>
        <p className="text-sm text-text-muted">
          {t("Quanto entrou, de que forma, e quanto cada pessoa tem a receber.")}
        </p>
      </div>
      <Faturamento />
    </div>
  );
}
