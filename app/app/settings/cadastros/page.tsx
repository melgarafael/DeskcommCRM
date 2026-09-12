import { notFound } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RegistrationRequestsClient } from "@/components/registration/RegistrationRequestsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cadastros pendentes" };

export default async function RegistrationRequestsPage() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin) notFound();
  const admin = createAdminClient();
  const { data } = await admin.from("registration_requests").select("id, user_id, requested_organization_name, created_at")
    .eq("kind", "create_organization").eq("status", "pending").order("created_at");
  const rows = await Promise.all((data ?? []).map(async (request) => {
    const { data: result } = await admin.auth.admin.getUserById(request.user_id);
    return { ...request, email: result.user?.email ?? null };
  }));
  return <RegistrationRequestsClient title="Solicitações para criar empresa" empty="Não há cadastros aguardando aprovação." requests={rows} mode="organization" />;
}
