import { PerfilCliente } from "@/components/agencia/PerfilCliente";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Perfil · Agência" };
export const dynamic = "force-dynamic";

export default async function PaginaDoPerfil() {
  const ctx = await requireAreaDaAgencia();
  const { data } = await createAdminClient()
    .from("agencia_membros")
    .select("nome, whatsapp, recebe_whatsapp")
    .eq("user_id", ctx.user.id)
    .maybeSingle();
  const linha = data as { nome: string; whatsapp: string; recebe_whatsapp: boolean } | null;
  const nomeDaConta = (ctx.user.user_metadata?.full_name as string | undefined) ?? "";

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Perfil</h1>
        <p className="text-sm text-muted-foreground">
          {linha
            ? "Seus dados na agência e como você recebe os avisos."
            : "Cadastre seu WhatsApp para receber os avisos da agência, como o resto da equipe."}
        </p>
      </div>
      <PerfilCliente
        inicial={{
          nome: linha?.nome ?? nomeDaConta,
          whatsapp: linha?.whatsapp ?? "",
          recebeWhatsapp: linha?.recebe_whatsapp ?? true,
        }}
        email={ctx.user.email ?? ""}
        novo={!linha}
      />
    </div>
  );
}
