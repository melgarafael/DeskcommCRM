"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { paisesOferecidos, perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { tenantSchema, type Locale, type TenantInput } from "@/lib/schemas/settings";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";

interface Props {
  initial: TenantInput;
  /**
   * Quem grava. Padrão: a server action do próprio tenant (Configurações ›
   * Empresa). A gestão de tenants do admin da plataforma passa a rota dela —
   * mesmos campos, mesma validação, outra autoridade.
   */
  onSave?: (dados: TenantInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Chamado depois de gravar com sucesso (ex.: fechar o diálogo do admin). */
  onSaved?: () => void;
}

// A mesma lista de toda tela de fuso — ver `lib/tempo/fusos.ts`.
const TIMEZONES = FUSOS_OFERECIDOS.map((f) => f.codigo);

export function TenantForm({ initial, onSave, onSaved }: Props) {
  const t = useT();
  const [form, setForm] = useState<TenantInput>(initial);
  const [isPending, startTransition] = useTransition();

  // O rótulo do nome legal e do número da empresa vem do PERFIL DO PAÍS
  // (issue #1946, item 4): a mesma troca de país que muda o documento do
  // contato muda estes dois rótulos. Escrevê-los aqui em duro mostrava
  // "Razão social"/"CNPJ" para uma organização em Portugal.
  const perfil = perfilDoPais(form.country);

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
      const r = await (onSave ?? updateTenant)(parsed.data);
      if (r.ok) {
        toast.success(t("Organização atualizada."));
        onSaved?.();
      } else toast.error(`${t("Erro")}: ${r.error}`);
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
            <Label htmlFor="legal_name">{t(perfil.empresa.rotuloNomeLegal)}</Label>
            <Input
              id="legal_name"
              value={form.legal_name}
              onChange={(e) => set("legal_name", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cnpj">{t(perfil.empresa.rotuloNumero)}</Label>
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
            {/* Quem responde pelo documento precisa saber que a revisão foi
                feita por IA (doc 88). O texto fala de Portugal: só o perfil PT
                declara `revisadaPorIa`, e um teste prende isso. */}
            {perfil.lei?.revisadaPorIa && (
              <p
                role="note"
                data-testid="aviso-revisao-por-ia"
                className="rounded-md border border-warning bg-warning-bg p-3 text-xs text-warning-fg"
              >
                {t(
                  "A citação do RGPD (artigo 15.º do Regulamento (UE) 2016/679) foi conferida contra o texto oficial numa revisão feita por IA, sem advogado em Portugal. Os prazos do sistema (7 e 15 dias úteis) são mais curtos que o prazo legal de um mês, e o relatório de acesso ainda não traz todas as informações do art. 15.º. Trocar o país muda a regra do documento do contato: a partir daí, CPF enviado por API, importação ou integração é recusado como NIF inválido. O sistema não substitui o seu encarregado da proteção de dados: confirme com ele os textos enviados aos titulares, sobretudo nas campanhas de marketing, que em Portugal, em regra, exigem consentimento prévio (Lei 41/2004, art. 13.º-A).",
                )}
              </p>
            )}
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
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="media_retention_enforced">
                {t("Limpeza automática de mídia antiga")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {form.media_retention_enforced
                  ? t("Ligado: apaga a mídia e o anexo de nota interna com mais de {n} dias.").replace(
                      "{n}",
                      String(form.media_retention_days),
                    )
                  : t("Desligado: a mídia das conversas e os anexos de nota interna não são apagados por idade.")}
              </p>
            </div>
            <Switch
              id="media_retention_enforced"
              checked={form.media_retention_enforced}
              onCheckedChange={(v) => {
                if (v && !form.media_retention_enforced) {
                  if (window.confirm(t("Ao ligar, a mídia de mensagem e o anexo de nota interna com mais de {n} dias começarão a ser apagados.").replace("{n}", String(form.media_retention_days)))) {
                    set("media_retention_enforced", true);
                  }
                } else {
                  set("media_retention_enforced", v);
                }
              }}
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
