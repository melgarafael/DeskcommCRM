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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLES, type Role } from "@/lib/schemas/team";
import { rotuloDoPapel } from "@/lib/auth/types";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * Criar a pessoa sem convite (#3876).
 *
 * A senha provisória é GERADA pelo servidor e aparece aqui uma única vez,
 * logo depois de criar — ela não fica guardada em lugar nenhum. A pessoa troca
 * no primeiro acesso; o aviso fica na tela para quem administra não tratar a
 * senha entregue como definitiva.
 */
export function CriarUsuarioForm() {
  const t = useT();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [settings, setSettings] = useState(INTERFACE_COMPLETA);
  const [criado, setCriado] = useState<{ email: string; senha: string } | null>(null);
  const criar = useCreateTeamUser();

  const podeEnviar =
    fullName.trim().length >= 2 &&
    email.trim().length > 3 &&
    interfaceSettingsSchema.safeParse(settings).success &&
    interfaceTemDestino(settings, role);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await criar.mutateAsync({
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        role,
        interface_settings: settings,
      });
      setCriado({ email: res.data.email, senha: res.data.senha_provisoria });
      toast.success(t("Usuário criado. Entregue o e-mail e a senha para a pessoa."));
      setFullName("");
      setEmail("");
    } catch {
      // A mensagem do servidor já saiu no toast (showApiError).
    }
  };

  const copiarSenha = async (senha: string) => {
    if (await copyToClipboard(senha)) toast.success(t("Senha copiada."));
    else toast.error(t("Não consegui copiar — selecione e copie a senha manualmente."));
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
            <div className="mt-3 space-y-1">
              <Label htmlFor="senha_provisoria">{t("Senha provisória")}</Label>
              <div className="flex gap-2">
                <Input
                  id="senha_provisoria"
                  readOnly
                  value={criado.senha}
                  className="font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={() => void copiarSenha(criado.senha)}>
                  {t("Copiar")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Esta senha aparece só agora. Ao sair desta tela ela não pode ser vista de novo.")}
              </p>
            </div>
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
