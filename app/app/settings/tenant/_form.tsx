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
import { updateTenant } from "@/app/actions/settings/updateTenant";
import { useT } from "@/hooks/i18n/useT";
import { IDIOMAS_VISIVEIS } from "@/lib/i18n/registro";
import { MOEDAS_SERVIDAS, simboloDaMoeda, type MoedaServida } from "@/lib/money";
import { paisesOferecidos } from "@/lib/legal/perfil-do-pais";
import { tenantSchema, type Locale, type TenantInput } from "@/lib/schemas/settings";

interface Props {
  initial: TenantInput;
}

const TIMEZONES = [
  "Africa/Luanda",
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Recife",
  "America/Fortaleza",
  "Europe/Lisbon",
  "UTC",
];

export function TenantForm({ initial }: Props) {
  const t = useT();
  const [form, setForm] = useState<TenantInput>(initial);
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof TenantInput>(key: K, value: TenantInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = tenantSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(t("Dados inválidos."));
      return;
    }
    startTransition(async () => {
      const r = await updateTenant(parsed.data);
      if (r.ok) toast.success(t("Organização atualizada."));
      else toast.error(`${t("Erro")}: ${r.error}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl">
      <Card className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="display_name">{t("Nome de exibição")}</Label>
            <Input
              id="display_name"
              value={form.display_name}
              onChange={(e) => set("display_name", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="legal_name">{t("Razão social")}</Label>
            <Input
              id="legal_name"
              value={form.legal_name}
              onChange={(e) => set("legal_name", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cnpj">{t("CNPJ")}</Label>
            <Input
              id="cnpj"
              value={form.cnpj ?? ""}
              onChange={(e) => set("cnpj", e.target.value || null)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dpo_email">{t("DPO email")}</Label>
            <Input
              id="dpo_email"
              type="email"
              value={form.dpo_email ?? ""}
              onChange={(e) => set("dpo_email", e.target.value || null)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">{t("Fuso horário")}</Label>
            <Select value={form.timezone} onValueChange={(v) => set("timezone", v)}>
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
          <div className="space-y-2">
            <Label htmlFor="locale">{t("Idioma")}</Label>
            <Select
              value={form.locale}
              onValueChange={(v) => set("locale", v as Locale)}
            >
              <SelectTrigger id="locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
                  <SelectItem key={codigo} value={codigo}>
                    {nomeNativo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="currency">{t("Moeda")}</Label>
            <Select
              value={form.currency}
              onValueChange={(v) => set("currency", v as MoedaServida)}
            >
              <SelectTrigger id="currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MOEDAS_SERVIDAS.map((moeda) => (
                  <SelectItem key={moeda} value={moeda}>
                    {moeda} · {simboloDaMoeda(moeda)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("Vale para todo preço do catálogo. Produto já cadastrado guarda a moeda com que nasceu.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">{t("País")}</Label>
            <Select value={form.country ?? "BR"} onValueChange={(v) => set("country", v)}>
              <SelectTrigger id="country">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paisesOferecidos().map((pais) => (
                  <SelectItem key={pais.codigo} value={pais.codigo}>
                    {pais.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(
                "De onde saem o documento do contato, a lei citada no documento de acesso e o prazo em dias úteis. Só aparecem países com a lei revisada — a lista é curta de propósito.",
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="media_retention_days">{t("Retenção de mídia (dias)")}</Label>
            <Input
              id="media_retention_days"
              type="number"
              min={30}
              max={3650}
              value={form.media_retention_days}
              onChange={(e) => set("media_retention_days", Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="privacy_policy_url">{t("URL política de privacidade")}</Label>
            <Input
              id="privacy_policy_url"
              type="url"
              value={form.privacy_policy_url ?? ""}
              onChange={(e) => set("privacy_policy_url", e.target.value || null)}
            />
          </div>
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
