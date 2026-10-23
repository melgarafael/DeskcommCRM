import { requireAreaDaAgencia } from "@/lib/agencia/acesso";

export const metadata = { title: "Agência" };

export default async function InicioDaAgencia() {
  const ctx = await requireAreaDaAgencia();
  const nome = (ctx.user.user_metadata?.full_name as string | undefined)?.split(" ")[0];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{nome ? `Olá, ${nome}` : "Olá"}</h1>
        <p className="text-sm text-muted-foreground">
          Esta é a área da agência. Tarefas, calendário e clientes chegam aqui nas próximas etapas.
        </p>
      </div>
    </div>
  );
}
