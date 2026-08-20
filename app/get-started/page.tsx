import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { branding } from "@/lib/branding";
import { RecoverOrganizationForm } from "@/components/auth/RecoverOrganizationForm";

export const dynamic = "force-dynamic";

export default async function GetStartedPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (activeOrg) redirect("/app/inbox");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-md space-y-6 rounded-lg border bg-background p-6 shadow-sm">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{branding().name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Configure sua organização</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Sua conta foi confirmada, mas a organização inicial ainda não foi criada. Informe o nome da
            sua empresa para concluir o primeiro acesso e abrir o onboarding do CRM.
          </p>
        </div>
        <RecoverOrganizationForm />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Se você recebeu um convite, não crie uma organização nova. Use o link do convite ou peça ao
          administrador para reenviá-lo.
        </p>
      </div>
    </main>
  );
}
