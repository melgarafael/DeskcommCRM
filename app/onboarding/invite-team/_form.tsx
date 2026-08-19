"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { copyToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";
import { ROLES, type Role } from "@/lib/schemas/team";
import { ROTULO_DO_PAPEL } from "@/lib/auth/types";

export function InviteTeamForm() {
  const [emailsRaw, setEmailsRaw] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [undelivered, setUndelivered] = useState<{ email: string; accept_url: string }[]>([]);
  const [pending, startTransition] = useTransition();

  const submit = (skip: boolean) => {
    startTransition(async () => {
      if (skip) {
        const res = await sendOnboardingInvites({ invitations: [], skip: true });
        if (res && !res.ok) toast.error(`Falha: ${res.error}`);
        return;
      }
      const emails = Array.from(
        new Set(
          emailsRaw
            .split(/[\n,;]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      if (emails.length === 0) {
        toast.error("Adicione ao menos um email ou clique em Pular.");
        return;
      }
      if (emails.length > 20) {
        toast.error("Máximo 20 emails por convite.");
        return;
      }
      const res = await sendOnboardingInvites({
        invitations: emails.map((email) => ({ email, role })),
      });
      if (res && !res.ok) {
        toast.error(`Falha: ${res.error}`);
        return;
      }
      if (res && res.ok && res.undelivered?.length) {
        // Sem serviço de email configurado: mostra os links de aceite pro
        // admin mandar por conta própria — nunca fingir que o email saiu.
        setUndelivered(res.undelivered);
        toast.warning(
          `${res.failed} convite(s) não puderam ser enviados por email. Copie os links abaixo e envie você mesmo.`,
        );
      }
      // sucesso total redireciona no server action
    });
  };

  return (
    <div className="space-y-4 rounded-lg border bg-background p-6">
      <div className="space-y-2">
        <Label htmlFor="emails">E-mail de quem vai trabalhar com ele</Label>
        <Textarea
          id="emails"
          value={emailsRaw}
          onChange={(e) => setEmailsRaw(e.target.value)}
          rows={6}
          placeholder={"alice@empresa.com\nbob@empresa.com"}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role">O que essas pessoas podem fazer</Label>
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger id="role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/*
              Os valores do banco (viewer, agent, manager, admin) apareciam
              crus no seletor. O produto já traduz esses papéis em
              `ROTULO_DO_PAPEL` — a tela do wizard era a única que não usava.
            */}
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROTULO_DO_PAPEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {undelivered.length > 0 && (
        <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/20">
          <p className="text-sm font-medium">
            Esta instalação não envia e-mail. Os convites estão prontos — copie o link de
            cada pessoa e mande por onde você já fala com ela:
          </p>
          <ul className="space-y-2">
            {undelivered.map((u) => (
              <li key={u.email} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="font-medium">{u.email}</span>{" "}
                  <code className="break-all text-muted-foreground">{u.accept_url}</code>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void copyToClipboard(u.accept_url).then((ok) => {
                      if (ok) toast.success("Link copiado.");
                      else toast.error("Não consegui copiar — selecione e copie o link manualmente.");
                    });
                  }}
                >
                  Copiar link
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex sm:justify-end">
            <Button type="button" onClick={() => (window.location.href = "/onboarding")} className="w-full sm:w-auto">
              Continuar
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={() => submit(true)}>
          Pular por enquanto
        </Button>
        <Button type="button" disabled={pending} onClick={() => submit(false)}>
          {pending ? "Enviando..." : "Enviar convites"}
        </Button>
      </div>
    </div>
  );
}
