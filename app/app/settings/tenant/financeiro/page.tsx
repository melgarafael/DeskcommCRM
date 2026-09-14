import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { CatalogoFinanceiro } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O CATÁLOGO FINANCEIRO — a camada que a comanda vai precisar.
 *
 * Contas, formas de pagamento e plano de contas não movimentam dinheiro: eles
 * definem PARA ONDE ele vai. A forma de pagamento é quem decide em que conta a
 * entrada cai quando uma comanda é fechada — por isso esta tela existe antes de
 * qualquer tela de venda, e não depois.
 *
 * Fica em Configurações, junto de Agenda, pelo mesmo motivo que os tipos de
 * agendamento ficam: é onde o negócio se DESCREVE. O dia acontece em outro lugar.
 *
 * Escrita é de manager+ — a RLS diz isso e esta página só decide o que mostrar.
 * Quem atende não define plano de contas.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  // Sem organização ativa não há catálogo — mesmo caminho da tela irmã de
  // Agenda, e não um 500 por `org.role` de null.
  if (!org) redirect("/app");
  const podeEditar = ROLE_RANK[org.role] >= ROLE_RANK.manager;
  // Server Component não tem `useT`: a tradução vem do idioma do usuário, como
  // na tela irmã de Agenda. Texto solto aqui reprova o gate de espanhol — e com
  // razão, porque é texto que a pessoa lê.
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Financeiro")}</h1>
        <p className="text-sm text-text-muted">
          {t("Onde o dinheiro fica, como o cliente paga e como cada lançamento é classificado.")}
        </p>
      </div>
      <CatalogoFinanceiro podeEditar={podeEditar} />
    </div>
  );
}
