"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { connectNuvemshop } from "@/app/actions/integrations/connectNuvemshop";
import { disconnectNuvemshop } from "@/app/actions/integrations/disconnectNuvemshop";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

const CONNECT_ERRORS: Record<string, string> = {
  auth_required: "Faça login para conectar.",
  no_active_org: "Nenhuma organização ativa.",
  forbidden: "Apenas admins podem conectar integrações.",
  not_configured: "Integração não configurada — configure as credenciais em .env.local.",
};

const DISCONNECT_ERRORS: Record<string, string> = {
  auth_required: "Faça login para desconectar.",
  no_active_org: "Nenhuma organização ativa.",
  forbidden: "Apenas admins podem desconectar.",
  not_connected: "Integração não está conectada.",
  db_error: "Falha de banco ao desconectar.",
};

export function ConnectButton({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      onClick={() =>
        startTransition(async () => {
          const res = await connectNuvemshop();
          // Server Action redirects on success — we only get a result on failure.
          if (res && !res.ok) {
            if (res.error === "mfa_required") return irAoDesafioDeMfa();
            toast.error(t(CONNECT_ERRORS[res.error] ?? `Erro: ${res.error}`));
          }
        })
      }
      disabled={disabled || pending}
    >
      {pending ? t("Redirecionando…") : t("Conectar com Nuvemshop")}
    </Button>
  );
}

export function DisconnectButton() {
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      onClick={() =>
        startTransition(async () => {
          const res = await disconnectNuvemshop();
          if (res.ok) {
            toast.success(t("Nuvemshop desconectada."));
          } else if (res.error === "mfa_required") {
            irAoDesafioDeMfa();
          } else {
            toast.error(t(DISCONNECT_ERRORS[res.error] ?? `Erro: ${res.error}`));
          }
        })
      }
      disabled={pending}
    >
      {pending ? t("Desconectando…") : t("Desconectar")}
    </Button>
  );
}
