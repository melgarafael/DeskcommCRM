import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { AppointmentTypesClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function AppointmentTypesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tipos de agendamento</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Cada tipo tem duração e um responsável fixo — quem marca um horário desse tipo
          agenda direto com essa pessoa.
        </p>
      </header>
      <AppointmentTypesClient />
    </div>
  );
}
