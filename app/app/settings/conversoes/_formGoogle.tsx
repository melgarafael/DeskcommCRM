"use client";

/**
 * O formulário da conexão com o Google Ads.
 *
 * Diferente do irmão da Meta: não há campo de token. A credencial (refresh
 * token) chega pelo botão "Conectar com Google", que manda o admin para o
 * consentimento do Google (`/api/v1/plataformas-de-anuncio/google/connect`) —
 * esta tela só grava PARA ONDE reportar depois que a autorização já existe.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateGoogleAdsConnection } from "@/app/actions/settings/updateGoogleAdsConnection";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDaConexaoGoogle } from "@/lib/plataformas-de-anuncio/google/estado-da-conexao";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeConversoesGoogle({
  estado,
  idioma,
}: {
  estado: EstadoDaConexaoGoogle;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [customerId, setCustomerId] = useState(estado.customerId ?? "");
  const [loginCustomerId, setLoginCustomerId] = useState(estado.loginCustomerId ?? "");
  const [conversionActionId, setConversionActionId] = useState(estado.conversionActionId ?? "");
  const [habilitada, setHabilitada] = useState(estado.habilitada);

  const podeSalvar =
    customerId.replace(/\D/g, "").length === 10 && conversionActionId.trim().length > 0;

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateGoogleAdsConnection({
        customer_id: customerId,
        login_customer_id: loginCustomerId.trim() || null,
        conversion_action_id: conversionActionId.trim(),
        enabled: habilitada,
      });

      if (resultado.ok) {
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  if (!estado.temRefreshToken) {
    return (
      <Card className="p-6">
        <div className="flex flex-col gap-3">
          <h3 className="font-medium">{t("Google Ads")}</h3>
          <p className="text-sm text-muted-foreground">
            {t(
              "Autorize o acesso à conta de anúncios do Google. Depois de autorizar, você informa aqui qual conta e qual ação de conversão recebem as vendas.",
            )}
          </p>
          <a href="/api/v1/plataformas-de-anuncio/google/connect">
            <Button type="button">{t("Conectar com Google")}</Button>
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{t("Google Ads")}</h3>
          <a href="/api/v1/plataformas-de-anuncio/google/connect" className="text-xs underline underline-offset-2">
            {t("Reconectar")}
          </a>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="google_customer_id">{t("Conta de anúncios (Customer ID)")}</Label>
          <Input
            id="google_customer_id"
            inputMode="numeric"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="123-456-7890"
          />
          <p className="text-xs text-muted-foreground">
            {t("10 dígitos. Com ou sem hífen — tanto faz, a gente limpa.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="google_login_customer_id">{t("Conta de gerente (opcional)")}</Label>
          <Input
            id="google_login_customer_id"
            inputMode="numeric"
            value={loginCustomerId}
            onChange={(e) => setLoginCustomerId(e.target.value)}
            placeholder="123-456-7890"
          />
          <p className="text-xs text-muted-foreground">
            {t("Preencha só se você acessa a conta acima através de uma conta MCC/gerente.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="google_conversion_action_id">{t("Ação de conversão")}</Label>
          <Input
            id="google_conversion_action_id"
            inputMode="numeric"
            value={conversionActionId}
            onChange={(e) => setConversionActionId(e.target.value)}
            placeholder="123456789"
          />
          <p className="text-xs text-muted-foreground">
            {t("O ID da ação de conversão dentro da conta acima, que vai receber os envios de venda.")}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Switch id="google_enabled" checked={habilitada} onCheckedChange={setHabilitada} />
          <Label htmlFor="google_enabled">{t("Enviar vendas para o Google Ads")}</Label>
        </div>

        <Button type="submit" disabled={!podeSalvar || isPending}>
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
      </form>
    </Card>
  );
}
