import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function RegistrationPendingPage() {
  const user = await requireAuth();
  if (await resolveActiveOrg(user)) redirect("/app/inbox");
  const admin = createAdminClient();
  const { data: request } = await admin.from("registration_requests").select("kind, status")
    .eq("user_id", user.id).eq("status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!request) redirect("/login?error=cadastro_sem_solicitacao");
  const subject = request.kind === "create_organization" ? "a criação da sua empresa" : "a entrada na empresa escolhida";
  return <main className="flex min-h-screen items-center justify-center bg-muted/40 px-4"><section className="w-full max-w-md space-y-3 rounded-lg border bg-background p-6 text-center shadow-sm"><h1 className="text-2xl font-semibold">Cadastro em análise</h1><p className="text-sm text-muted-foreground">Sua conta está pronta. Aguarde a aprovação para {subject}.</p><p className="text-xs text-muted-foreground">Quando a decisão for tomada, entre novamente para acessar a aplicação.</p></section></main>;
}
