import Link from "next/link";
import { emailDeSuporte } from "@/lib/branding/saida";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata = {
  title: "Conta suspensa",
};

/**
 * Esta tela entregava o NOSSO endereço de suporte ao cliente de um revendedor —
 * e aqui isso é ativamente errado: quem suspendeu a conta foi o revendedor, e
 * escrever para nós não desbloqueia nada. O endereço agora sai de
 * `SUPPORT_EMAIL` (o do operador) e, quando ninguém configurou, o parágrafo do
 * contato simplesmente NÃO renderiza. Cair de volta num endereço do produto
 * seria o defeito de volta, com o agravante de parecer resolvido.
 *
 * ADR-0002 (pivot billing): `suspended_reason` ramifica a cópia. A suposição
 * original — "quem suspendeu foi o revendedor" — deixou de valer para todo
 * bloqueio: inadimplência (`billing_overdue`) é o próprio tenant que pode
 * resolver, e mandá-lo escrever para o suporte em vez de pagar é fricção sem
 * propósito. Qualquer outro motivo (ou nenhum) mantém o texto administrativo
 * de sempre.
 */
export default async function AccountSuspendedPage() {
  const suporte = emailDeSuporte();

  let suspendedReason: string | null = null;
  const user = await loadAuthUser();
  if (user) {
    const activeOrg = await resolveActiveOrg(user);
    if (activeOrg) {
      const admin = createAdminClient();
      const { data: org } = await admin
        .from("organizations")
        .select("suspended_reason")
        .eq("id", activeOrg.orgId)
        .maybeSingle();
      suspendedReason = org?.suspended_reason ?? null;
    }
  }

  const isBillingOverdue = suspendedReason === "billing_overdue";

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center space-y-4">
        <h1 className="text-2xl font-semibold">
          {isBillingOverdue ? "Pagamento pendente" : "Conta suspensa"}
        </h1>
        {isBillingOverdue ? (
          <p className="text-sm text-muted-foreground">
            Sua assinatura está com uma cobrança em aberto. Atualize o pagamento
            para reativar o acesso automaticamente assim que ele for confirmado.
          </p>
        ) : suporte ? (
          <p className="text-sm text-muted-foreground">
            Sua conta está suspensa. Entre em contato com{" "}
            <a
              href={`mailto:${suporte}`}
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              {suporte}
            </a>{" "}
            para mais informações.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sua conta está suspensa. Fale com quem administra este sistema para
            saber o motivo e como reativá-la.
          </p>
        )}
        {/*
         * Sem CTA "Atualizar pagamento" aqui de propósito (ainda): a tela de
         * billing real (`/app/settings/billing`) vive sob `app/app/layout.tsx`,
         * que redireciona QUALQUER rota `/app/*` para cá quando a org está
         * suspensa — um link para lá hoje seria um beco sem saída. A Fase 3
         * do pivot (tela de billing real) traz a exceção de rota no layout
         * JUNTO com o botão, para as duas nascerem consistentes.
         */}
        <div className="pt-2 flex justify-center gap-2">
          <Button asChild variant="outline">
            <Link href="/login">Sair</Link>
          </Button>
        </div>
      </Card>
    </main>
  );
}
