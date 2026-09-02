import { requireAuth } from "@/lib/auth/server";
import { MeuHorarioClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function MeuHorarioPage() {
  const user = await requireAuth();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Meu horário de agendamento</h1>
        <p className="text-sm text-muted-foreground">
          Os dias e horários em que clientes podem marcar um agendamento com você.
        </p>
      </header>
      <MeuHorarioClient userId={user.id} />
    </div>
  );
}
