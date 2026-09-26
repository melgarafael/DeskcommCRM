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
  etapas = [],
  erroEtapas = false,
  idioma,
  configurado,
  falta,
  dataManagerConfigurado = false,
}: {
  etapas?: Array<{ id: string; nome: string }>;
  erroEtapas?: boolean;
  estado: EstadoDaConexaoGoogle;
  idioma: Idioma;
  /** A instalação tem as três variáveis do Google Ads? Ver `config.ts`. */
  configurado: boolean;
  /** O que falta, PELO NOME — para a tela dizer em vez de só esconder o botão. */
  falta: string[];
  dataManagerConfigurado?: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [customerId, setCustomerId] = useState(estado.customerId ?? "");
  const [loginCustomerId, setLoginCustomerId] = useState(estado.loginCustomerId ?? "");
  const [conversionActionId, setConversionActionId] = useState(estado.conversionActionId ?? "");
  const [etapaQualificada, setEtapaQualificada] = useState(estado.qualificationStageId ?? "");
  const [acaoQualificada, setAcaoQualificada] = useState(estado.qualificationActionId ?? "");
  const [habilitada, setHabilitada] = useState(estado.habilitada);

  const api = estado.api ?? "data_manager";
  const linkDeConexao = `/api/v1/plataformas-de-anuncio/google/connect?api=${api}`;

  const podeSalvar =
    customerId.replace(/\D/g, "").length === 10 &&
    conversionActionId.trim().length > 0 &&
    !erroEtapas &&
    (!etapaQualificada ||
      (acaoQualificada.trim().length > 0 && acaoQualificada.trim() !== conversionActionId.trim()));

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateGoogleAdsConnection({
        customer_id: customerId,
        login_customer_id: loginCustomerId.trim() || null,
        conversion_action_id: conversionActionId.trim(),
        enabled: habilitada,
        qualification: {
          stage_id: etapaQualificada || null,
          action_id: etapaQualificada ? acaoQualificada.trim() : null,
        },
      });

      if (resultado.ok) {
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  /*
   * Sem as credenciais da INSTALAÇÃO, o botão não existe — mesmo quando a
   * organização já conectou antes: sem elas o envio recusa toda venda
   * (`conversions.ts`), e mostrar o formulário diria que está tudo de pé. O
   * molde é o cartão da Agenda (`CartaoDaConexaoGoogle`): não é "você não
   * pode", é "esta instalação ainda não tem", e quem lê pode repassar o que
   * falta a quem instalou.
   */
  if (!configurado) {
    return (
      <Card className="p-6" data-testid="google-ads-nao-configurado">
        <div className="flex flex-col gap-2">
          <h3 className="font-medium">{t("Google Ads")}</h3>
          {api === "google_ads" && dataManagerConfigurado && (
            <a
              className="text-sm underline"
              href="/api/v1/plataformas-de-anuncio/google/connect?api=data_manager"
            >
              {t("Autorizar nova integração do Google")}
            </a>
          )}
          <p className="text-sm text-muted-foreground">
            {t(
              "Enviar conversões para o Google Ads ainda não está disponível nesta instalação — não é nada que você tenha feito. Quem instalou o sistema precisa configurar",
            )}
            {falta.length > 0 ? (
              <>
                {" "}
                <span data-testid="google-ads-o-que-falta" className="font-mono text-xs">
                  {falta.join(` ${t("e")} `)}
                </span>
              </>
            ) : (
              ` ${t("as credenciais")}`
            )}
          </p>
        </div>
      </Card>
    );
  }

  if (!estado.temRefreshToken) {
    return (
      <Card className="p-6">
        <div className="flex flex-col gap-3">
          <h3 className="font-medium">{t("Google Ads")}</h3>
          {api === "google_ads" && dataManagerConfigurado && (
            <a
              className="text-sm underline"
              href="/api/v1/plataformas-de-anuncio/google/connect?api=data_manager"
            >
              {t("Autorizar nova integração do Google")}
            </a>
          )}
          <p className="text-sm text-muted-foreground">
            {t(
              "Autorize o acesso à conta de anúncios do Google. Depois de autorizar, você informa aqui qual conta e qual ação de conversão recebem as vendas.",
            )}
          </p>
          <a href={linkDeConexao}>
            <Button type="button">{t("Conectar com Google")}</Button>
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          {t(
            api === "data_manager"
              ? "Integração atual: Data Manager. Ative a Data Manager API no projeto Google Cloud usado na autorização. A confirmação pode levar alguns minutos."
              : "Integração anterior do Google Ads. Novas contas podem precisar autorizar a Data Manager API.",
          )}
        </p>
        <div className="flex items-center justify-between">
          <h3 className="font-medium">{t("Google Ads")}</h3>
          {api === "google_ads" && dataManagerConfigurado && (
            <a
              className="text-sm underline"
              href="/api/v1/plataformas-de-anuncio/google/connect?api=data_manager"
            >
              {t("Autorizar nova integração do Google")}
            </a>
          )}
          <a href={linkDeConexao} className="text-xs underline underline-offset-2">
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
            {t(
              "O ID da ação de conversão dentro da conta acima, que vai receber os envios de venda.",
            )}
          </p>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">{t("Lead qualificado (opcional)")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "Ao entrar na etapa escolhida, o negócio envia uma qualificação sem valor monetário. A compra continua sendo enviada ao ganhar o negócio com valor. Cada evento é contado uma vez por negócio.",
            )}
          </p>
          <Label htmlFor="google_qualification_stage">{t("Etapa de qualificação")}</Label>
          <select
            id="google_qualification_stage"
            className="rounded-md border bg-background p-2 text-sm"
            value={etapaQualificada}
            onChange={(e) => setEtapaQualificada(e.target.value)}
            disabled={erroEtapas}
          >
            <option value="">{t("Não enviar qualificação")}</option>
            {etapaQualificada && !etapas.some((e) => e.id === etapaQualificada) && (
              <option value={etapaQualificada}>{t("Etapa indisponível — escolha outra")}</option>
            )}
            {etapas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nome}
              </option>
            ))}
          </select>
          {erroEtapas && (
            <p role="alert">
              {t("Não foi possível carregar as etapas. Atualize a página antes de salvar.")}
            </p>
          )}
          {etapaQualificada && (
            <>
              <Label htmlFor="google_qualification_action">
                {t("Ação de conversão de lead qualificado")}
              </Label>
              <Input
                id="google_qualification_action"
                inputMode="numeric"
                value={acaoQualificada}
                onChange={(e) => setAcaoQualificada(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Informe uma ação do Google diferente da compra. Configure a categoria de lead qualificado e o uso na otimização no Google Ads. Salvar não envia qualificações antigas.",
                )}
              </p>
            </>
          )}
        </fieldset>

        <div className="flex items-center gap-3">
          <Switch id="google_enabled" checked={habilitada} onCheckedChange={setHabilitada} />
          <Label htmlFor="google_enabled">{t("Enviar conversões para o Google Ads")}</Label>
        </div>

        <Button type="submit" disabled={!podeSalvar || isPending}>
          {isPending ? t("Salvando...") : t("Salvar")}
        </Button>
      </form>
    </Card>
  );
}
