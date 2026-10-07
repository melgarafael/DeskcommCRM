import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { Comandas } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O BALCÃO — onde o atendimento vira dinheiro.
 *
 * Esta tela é a outra ponta de Configurações › Financeiro. Lá o negócio se
 * descreve (onde o dinheiro fica, como o cliente paga); aqui o dia acontece.
 *
 * Fica em CRM, e não em Configurações, por isso mesmo: é uso diário, de quem
 * está no balcão com a cliente na frente, não de quem define política uma vez
 * por ano.
 *
 * Ver é de `viewer` e lançar é de `agent` — a RLS decide, esta página só escolhe
 * o que mostrar. Estornar exige `manager`, e quem impõe isso é a própria função
 * no banco: desfazer dinheiro que já entrou é decisão de quem responde pelo
 * caixa.
 */
export default async function Page() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");

  const t = (texto: string) => traduzir(texto, user.idioma);
  // A moeda da organização é a régua dos pendentes (#1531): o preço sugerido
  // não tem coluna própria e nasce nela.
  const moedaDaOrg = await moedaDaOrganizacao(await createClient(), org.orgId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t("Comandas")}</h1>
        <p className="text-sm text-text-muted">
          {t("O que foi feito, por quem, e quanto o cliente paga.")}
        </p>
      </div>
      <Comandas
        podeLancar={ROLE_RANK[org.role] >= ROLE_RANK.agent}
        podeEstornar={ROLE_RANK[org.role] >= ROLE_RANK.manager}
        moedaDaOrg={moedaDaOrg}
      />
    </div>
  );
}
