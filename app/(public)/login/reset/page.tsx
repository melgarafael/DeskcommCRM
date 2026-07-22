import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata = { title: "Nova senha — DeskcommCRM" };

export default function ResetPasswordPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Definir nova senha</h1>
        <p className="text-sm text-muted-foreground">
          Escolha uma nova senha para sua conta
        </p>
      </div>
      <ResetPasswordForm />
    </div>
  );
}
