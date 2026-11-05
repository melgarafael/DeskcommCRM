"use client";

import { useState } from "react";
import { toast } from "sonner";

import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  interfaceTemDestino,
} from "@/lib/navigation/interface";
import { useT } from "@/hooks/i18n/useT";
import { useCreateTeamUser } from "@/hooks/team/useCreateTeamUser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/auth/PasswordStrength";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLES, type Role } from "@/lib/schemas/team";
import { senhaForteSchema } from "@/lib/auth/schemas";
import { rotuloDoPapel } from "@/lib/auth/types";
import { ApiError } from "@/lib/api/types";

/**
 * Criar a pessoa sem convite (#3876).
 *
 * A senha é digitada por quem administra e a pessoa troca no primeiro acesso —
 * o aviso fica na tela, não só no corpo do PR: sem ele, o admin acharia que a
 * senha que ele escolheu é a definitiva e passaria a senha errada adiante.
 *
 * A validação local é a MESMA do servidor (`senhaForteSchema`, o schema da
 * recuperação de senha) — a do servidor continua sendo a que decide.
 */
export function CriarUsuarioForm() {
  const t = useT();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [settings, setSettings] = useState(INTERFACE_COMPLETA);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [criado, setCriado] = useState<{ email: string } | null>(null);
  const criar = useCreateTeamUser();

  const senhaValida = senhaForteSchema.safeParse(password).success;
  const senhasIguais = password.length > 0 && password === passwordConfirm;
  const podeEnviar =
    fullName.trim().length >= 2 &&
    email.trim().length > 3 &&
    senhaValida &&
    senhasIguais &&
    interfaceSettingsSchema.safeParse(settings).success &&
    interfaceTemDestino(settings, role);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await criar.mutateAsync({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        role,
        password,
        password_confirm: passwordConfirm,
        interface_settings: settings,
      });
      setCriado({ email: res.data.email });
      toast.success(t("Usuário criado. Entregue o e-mail e a senha para a pessoa."));
      setFullName("");
      setEmail("");
      setPassword("");
      setPasswordConfirm("");
    } catch (err) {
      // O toast já saiu (showApiError). 409 de e-mail repetido fica na tela:
      // a saída é convidar quem já tem conta, e isso não se resolve repetindo
      // o clique.
      if (err instanceof ApiError && err.code === "email_already_registered") {
        toast.error(t("Já existe uma conta com este e-mail."));
      }
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-[1fr,2fr]">
      <form onSubmit={onSubmit} className="space-y-4" autoComplete="off" noValidate>
        <div className="space-y-2">
          <Label htmlFor="full_name">{t("Nome")}</Label>
          <Input
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="off"
            maxLength={120}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t("E-mail")}</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="role">{t("Papel")}</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(rotuloDoPapel(r))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t("Senha provisória")}</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            aria-invalid={password.length > 0 && !senhaValida ? true : undefined}
          />
          {password.length > 0 && !senhaValida ? (
            <p className="text-xs text-destructive">
              {t("Mínimo de 8 caracteres, com letra, número e símbolo.")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("A pessoa será obrigada a trocar esta senha no primeiro acesso.")}
            </p>
          )}
          <PasswordStrength password={password} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password_confirm">{t("Confirmar senha provisória")}</Label>
          <Input
            id="password_confirm"
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={passwordConfirm.length > 0 && !senhasIguais ? true : undefined}
          />
          {passwordConfirm.length > 0 && !senhasIguais ? (
            <p className="text-xs text-destructive">{t("As senhas não coincidem")}</p>
          ) : null}
        </div>
        <InterfaceEditor
          value={settings}
          onChange={setSettings}
          role={role}
          disabled={criar.isPending}
        />
        <Button type="submit" disabled={criar.isPending || !podeEnviar}>
          {criar.isPending ? t("Criando…") : t("Criar usuário")}
        </Button>
      </form>

      <div className="space-y-4">
        {criado ? (
          <section className="rounded-md border p-3 text-sm">
            <h2 className="font-semibold">{t("Usuário criado")}</h2>
            <p className="mt-1 text-muted-foreground">
              {t(
                "Nenhum e-mail foi enviado. Entregue o e-mail e a senha provisória para a pessoa; ela escolhe a senha dela no primeiro acesso.",
              )}
            </p>
            <div className="mt-2 font-medium">{criado.email}</div>
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              "Diferente do convite, aqui a conta já existe ao fim do formulário — sem depender de e-mail, SMTP ou de a pessoa clicar num link.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}
