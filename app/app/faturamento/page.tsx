import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
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
 *
 * Os LANÇAMENTOS moram aqui e não numa tela própria, pelo mesmo motivo que o
 * catálogo financeiro tem três listas numa página: registrar o aluguel e ver o
 * saldo do mês são o mesmo ato mental. Separá-los obrigaria a pular entre telas
 * para responder "já paguei isso?".
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
      <Faturamento podeLancar={ROLE_RANK[org.role] >= ROLE_RANK.agent} />
    </div>
  );
}
