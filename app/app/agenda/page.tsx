import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { AgendaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function AgendaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Horários marcados. Para criar um agendamento novo, abra o dossiê do lead e use
          o botão &quot;Marcar horário&quot;.
        </p>
      </header>
      <AgendaClient />
    </div>
  );
}
