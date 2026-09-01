/**
 * PaySuite integration settings page — configura token/webhook secret.
 * Sem OAuth: PaySuite é token estático colado pelo admin (ver `_components/PaySuiteForm.tsx`).
 */
import { CreditCard } from "@/lib/ui/icons";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { PaySuiteForm } from "./_components/PaySuiteForm";

export default async function PaySuiteIntegrationPage() {
  const user = await loadAuthUser();
  const activeOrg = user ? await resolveActiveOrg(user) : null;
  const isAdmin = activeOrg?.role === "admin" || user?.is_platform_admin === true;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-start gap-4">
        <div className="rounded-md border border-border bg-surface p-3">
          <CreditCard size={28} weight="duotone" className="text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">PaySuite</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cobrança por M-Pesa, e-Mola e cartão diretamente dos negócios do CRM.
          </p>
        </div>
      </header>
      <PaySuiteForm isAdmin={isAdmin} />
    </div>
  );
}
