"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkSmtp, updateSmtp } from "@/app/actions/settings/smtp";
import type { SmtpConfig } from "@/lib/email/config";

export function SmtpSettingsForm({ config }: { config: SmtpConfig }) {
  const [form, setForm] = useState({
    host: config.host,
    port: String(config.port),
    security: config.security,
    username: config.username,
    password: "",
    from_email: config.fromEmail,
    from_name: config.fromName,
  });
  const [busy, start] = useTransition();
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const test = () =>
    start(async () => {
      const result = await checkSmtp();
      if (result.ok) toast.success("SMTP conectado e autenticado.");
      else
        toast.error(
          "Não foi possível validar o SMTP. Confira host, porta, segurança e credenciais.",
        );
    });
  const save = () =>
    start(async () => {
      const result = await updateSmtp(form);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Configuração SMTP salva.");
      set("password", "");
    });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">E-mail SMTP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Convites, LGPD e alertas usam este servidor.
        </p>
      </header>
      <Card className="grid gap-4 p-4">
        <div>
          <Label htmlFor="smtp-host">Servidor SMTP</Label>
          <Input
            id="smtp-host"
            value={form.host}
            onChange={(event) => set("host", event.target.value)}
            placeholder="smtp.seudominio.com"
          />
        </div>
        <div>
          <Label htmlFor="smtp-port">Porta</Label>
          <Input
            id="smtp-port"
            inputMode="numeric"
            value={form.port}
            onChange={(event) => set("port", event.target.value)}
            placeholder="465 ou 587"
          />
        </div>
        <div>
          <Label htmlFor="smtp-security">Segurança</Label>
          <select
            id="smtp-security"
            className="w-full rounded-md border bg-background p-2"
            value={form.security}
            onChange={(event) => set("security", event.target.value)}
          >
            <option value="starttls">STARTTLS (normalmente porta 587)</option>
            <option value="tls">TLS/SSL (normalmente porta 465)</option>
            <option value="none">Sem TLS</option>
          </select>
        </div>
        <div>
          <Label htmlFor="smtp-username">Usuário</Label>
          <Input
            id="smtp-username"
            value={form.username}
            onChange={(event) => set("username", event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="smtp-password">Senha</Label>
          <Input
            id="smtp-password"
            type="password"
            value={form.password}
            onChange={(event) => set("password", event.target.value)}
            placeholder={config.password ? "•••••••• (já cadastrada)" : "Senha SMTP"}
          />
        </div>
        <div>
          <Label htmlFor="smtp-from-email">Remetente</Label>
          <Input
            id="smtp-from-email"
            type="email"
            value={form.from_email}
            onChange={(event) => set("from_email", event.target.value)}
            placeholder="suporte@seudominio.com"
          />
        </div>
        <div>
          <Label htmlFor="smtp-from-name">Nome</Label>
          <Input
            id="smtp-from-name"
            value={form.from_name}
            onChange={(event) => set("from_name", event.target.value)}
            placeholder="Minha empresa"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Use apenas o host, sem <code>smtp://</code> ou <code>:porta</code>. Para SSL, use 465 +
          TLS; para STARTTLS, 587 + STARTTLS.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={test}>
            Testar conexão
          </Button>
          <Button type="button" disabled={busy} onClick={save}>
            Salvar configuração
          </Button>
        </div>
      </Card>
    </div>
  );
}
