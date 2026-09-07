"use client";
import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  interfaceTemDestino,
} from "@/lib/navigation/interface";
import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useInviteMembers } from "@/hooks/team/useInviteMembers";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLES, type Role } from "@/lib/schemas/team";

interface ResultState {
  sent: Array<{ email: string; accept_url: string; email_dispatched: boolean; expires_at: string }>;
  failed: Array<{ email: string; reason: string }>;
}

export function InviteForm() {
  const t = useT();
  const [emailsRaw, setEmailsRaw] = useState("");
  const [settings, setSettings] = useState(INTERFACE_COMPLETA);
  const [role, setRole] = useState<Role>("agent");
  const [result, setResult] = useState<ResultState | null>(null);
  const invite = useInviteMembers();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const emails = emailsRaw
      .split(/[\n,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const unique = Array.from(new Set(emails));
    if (unique.length === 0) {
      toast.error(t("Adicione ao menos um email."));
      return;
    }
    if (unique.length > 20) {
      toast.error(t("Máximo 20 emails por convite."));
      return;
    }
    try {
      const res = await invite.mutateAsync({
        invitations: unique.map((email) => ({ email, role, interface_settings: settings })),
      });
      setResult(res.data);
      const ok = res.data.sent.length;
      const ko = res.data.failed.length;
      toast.success(
        `${ok} ${t("convite(s) enviado(s)")}${ko > 0 ? `, ${ko} ${t("falha(s).")}` : "."}`,
      );
      setEmailsRaw("");
    } catch {
      /* showApiError handled */
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr,2fr]">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="emails">Emails</Label>
          <Textarea
            id="emails"
            value={emailsRaw}
            onChange={(e) => setEmailsRaw(e.target.value)}
            rows={8}
            placeholder={"alice@empresa.com\nbob@empresa.com"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <InterfaceEditor
          value={settings}
          onChange={setSettings}
          role={role}
          disabled={invite.isPending}
        />
        <Button
          type="submit"
          disabled={
            invite.isPending ||
            !interfaceSettingsSchema.safeParse(settings).success ||
            !interfaceTemDestino(settings, role)
          }
        >
          {invite.isPending ? t("Enviando…") : t("Enviar convites")}
        </Button>
      </form>

      <div className="space-y-4">
        {result ? (
          <>
            {result.sent.length > 0 ? (
              <section>
                <h2 className="text-sm font-semibold">
                  {t("Enviados")} ({result.sent.length})
                </h2>
                <ul className="mt-2 space-y-2 text-sm">
                  {result.sent.map((s) => (
                    <li key={s.email} className="rounded-md border p-2">
                      <div className="font-medium">{s.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.email_dispatched
                          ? t("Email enviado.")
                          : t("Resend não configurado — link copiável abaixo (DEV).")}
                      </div>
                      {!s.email_dispatched ? (
                        <code className="mt-1 block text-xs break-all">{s.accept_url}</code>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {result.failed.length > 0 ? (
              <section>
                <h2 className="text-sm font-semibold text-destructive">
                  {t("Falhas")} ({result.failed.length})
                </h2>
                <ul className="mt-2 space-y-1 text-sm">
                  {result.failed.map((f) => (
                    <li key={f.email}>
                      <span className="font-medium">{f.email}</span>{" "}
                      <span className="text-muted-foreground">— {f.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Resultados aparecerão aqui após o envio.")}
          </p>
        )}
      </div>
    </div>
  );
}
