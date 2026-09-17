"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateProfile } from "@/app/actions/settings/updateProfile";
import { useT } from "@/hooks/i18n/useT";
import { IDIOMAS_VISIVEIS } from "@/lib/i18n/registro";
import {
  profileSchema,
  SEM_PREFERENCIA_DE_IDIOMA,
  type Locale,
} from "@/lib/schemas/settings";

const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Recife",
  "America/Fortaleza",
  "UTC",
];

interface Props {
  email: string;
  initialFullName: string | null;
  initialAvatarUrl: string | null;
  initialLocale: Locale | typeof SEM_PREFERENCIA_DE_IDIOMA;
  initialTimezone: string;
}

export function ProfileForm({
  email,
  initialFullName,
  initialAvatarUrl,
  initialLocale,
  initialTimezone,
}: Props) {
  const t = useT();
  const [fullName, setFullName] = useState(initialFullName ?? "");
  const [locale, setLocale] = useState<Locale | typeof SEM_PREFERENCIA_DE_IDIOMA>(initialLocale);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl ?? "");
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = profileSchema.safeParse({
      full_name: fullName || null,
      locale,
      timezone,
      avatar_url: avatarUrl || null,
    });
    if (!parsed.success) {
      toast.error(t("Dados inválidos."));
      return;
    }
    startTransition(async () => {
      const r = await updateProfile(parsed.data);
      if (r.ok) toast.success(t("Perfil atualizado."));
      else toast.error(`${t("Erro")}: ${r.error}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl">
      <Card className="space-y-4 p-6">
        <div className="space-y-2">
          <Label htmlFor="email">{t("Email")}</Label>
          <Input id="email" value={email} disabled />
          <p className="text-xs text-muted-foreground">
            {t("Trocar email — em breve.")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="full_name">{t("Nome completo")}</Label>
          <Input
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="locale">{t("Idioma")}</Label>
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger id="locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_PREFERENCIA_DE_IDIOMA}>
                  {t("Seguir o idioma da empresa")}
                </SelectItem>
                {/* A lista vem do registro, e só com o que o nível deixa
                    aparecer. Oferecer um idioma que não muda a tela é prometer
                    o que ela não cumpre — `en-US` saiu por isso, e um idioma
                    em construção fica fora pela mesma razão. */}
                {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
                  <SelectItem key={codigo} value={codigo}>
                    {nomeNativo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">{t("Fuso horário")}</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="avatar_url">{t("Avatar URL")}</Label>
          <Input
            id="avatar_url"
            type="url"
            placeholder="https://…"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Upload de arquivo — em breve. Cole uma URL pública.")}
          </p>
        </div>
        <div className="flex sm:justify-end">
          <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
            {isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>
    </form>
  );
}
