"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type {
  BlingFeatures,
  BlingIntegrationConfig,
  BlingSyncLog,
} from "@/lib/integrations/bling/types";

interface BlingConfigClientProps {
  initialConfig: BlingIntegrationConfig | null;
  initialLogs: BlingSyncLog[];
  idioma: Idioma;
}

export function BlingConfigClient({
  initialConfig,
  initialLogs,
  idioma,
}: BlingConfigClientProps) {
  const t = (texto: string) => traduzir(texto, idioma);

  const [config, setConfig] = useState<BlingIntegrationConfig | null>(initialConfig);
  const [logs, setLogs] = useState<BlingSyncLog[]>(initialLogs);

  // Form states
  const [clientId, setClientId] = useState(initialConfig?.client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [accessTokenManual, setAccessTokenManual] = useState("");

  const [isSavingCreds, setIsSavingCreds] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isUpdatingFeatures, setIsUpdatingFeatures] = useState(false);
  const [isSyncingProducts, setIsSyncingProducts] = useState(false);

  const isConnected = config?.status === "connected";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "true") {
      toast.success(t("Bling conectado com sucesso!"));
      window.history.replaceState({}, "", window.location.pathname);
      fetch("/api/v1/integrations/bling")
        .then((res) => res.json())
        .then((json) => {
          if (json.data?.config) setConfig(json.data.config);
          if (json.data?.logs) setLogs(json.data.logs);
        })
        .catch(() => {});
    } else if (params.get("error")) {
      const err = params.get("error");
      if (err === "denied") toast.error(t("Autorização cancelada no Bling"));
      else if (err === "missing_client_id") toast.error(t("Salve o Client ID antes de conectar"));
      else toast.error(t("Falha ao autorizar com o Bling: ") + err);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const isMasterEnabled = config?.is_enabled ?? false;
  const features: BlingFeatures = config?.features ?? {
    sync_contacts: false,
    sync_products: false,
    ai_stock_consult: false,
    auto_create_order: false,
    invoice_emission: false,
    tracking_notifications: false,
    financial_bills: false,
    ai_fiscal_agent: false,
  };

  async function handleSalvarCredenciais(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId.trim()) {
      toast.error(t("Informe o Client ID do Bling"));
      return;
    }

    setIsSavingCreds(true);
    try {
      const res = await fetch("/api/v1/integrations/bling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || undefined,
          accessToken: accessTokenManual.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || t("Falha ao salvar credenciais"));
      }

      toast.success(t("Credenciais do Bling salvas com sucesso!"));
      if (json.data?.config) {
        setConfig(json.data.config);
      }
      setClientSecret("");
      setAccessTokenManual("");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSavingCreds(false);
    }
  }

  async function handleTestarConexao() {
    setIsTesting(true);
    try {
      const res = await fetch("/api/v1/integrations/bling/test", {
        method: "POST",
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || t("Falha no teste de conexão com o Bling"));
      }

      toast.success(t("Conexão com o Bling validada com sucesso!"));
      // Atualiza logs
      const refreshRes = await fetch("/api/v1/integrations/bling");
      if (refreshRes.ok) {
        const refreshJson = await refreshRes.json();
        if (refreshJson.data?.logs) setLogs(refreshJson.data.logs);
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsTesting(false);
    }
  }

  async function handleToggleMaster(checked: boolean) {
    setIsUpdatingFeatures(true);
    try {
      const res = await fetch("/api/v1/integrations/bling", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled: checked }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || t("Erro ao alterar status geral"));
      }

      toast.success(checked ? t("Integração com o Bling ativada!") : t("Integração com o Bling desativada!"));
      if (json.data?.config) setConfig(json.data.config);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsUpdatingFeatures(false);
    }
  }

  async function handleToggleFeature(featureKey: keyof BlingFeatures, checked: boolean) {
    setIsUpdatingFeatures(true);
    try {
      const res = await fetch("/api/v1/integrations/bling", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: {
            [featureKey]: checked,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || t("Erro ao atualizar recurso"));
      }

      toast.success(t("Configuração atualizada!"));
      if (json.data?.config) setConfig(json.data.config);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsUpdatingFeatures(false);
    }
  }

  async function handleDesconectar() {
    if (!confirm(t("Tem certeza que deseja desconectar a integração com o Bling?"))) {
      return;
    }

    try {
      const res = await fetch("/api/v1/integrations/bling", {
        method: "DELETE",
      });

      if (!res.ok) throw new Error(t("Falha ao desconectar"));

      toast.success(t("Bling desconectado com sucesso"));
      setConfig(null);
      setClientId("");
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleSyncProducts() {
    setIsSyncingProducts(true);
    try {
      const res = await fetch("/api/v1/integrations/bling/sync-products", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || t("Falha ao sincronizar produtos"));
      }
      toast.success(
        json.data?.mensagem ||
          t("Sincronização de produtos concluída com sucesso!"),
      );
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSyncingProducts(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <div className="flex items-center justify-between p-4 rounded-lg border bg-card/60 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-primary" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{t("Status da Conexão:")}</span>
              {isConnected ? (
                <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600 text-xs">
                  {t("Conectado")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  {t("Desconectado")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {config?.last_synced_at
                ? `${t("Última sincronização:")} ${new Date(config.last_synced_at).toLocaleString("pt-BR")}`
                : t("Nenhuma sincronização recente")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestarConexao}
                disabled={isTesting}
              >
                {isTesting ? t("Testando...") : t("Testar Conexão")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDesconectar}
              >
                {t("Desconectar")}
              </Button>
            </>
          ) : (
            Boolean(config?.client_id) && (
              <Button
                asChild
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm"
              >
                <a href="/api/v1/integrations/bling/connect">
                  {t("Conectar com Bling")}
                </a>
              </Button>
            )
          )}
        </div>
      </div>

      {/* Card 1: Chave Mestra Liga/Desliga */}
      <Card className="border-border/60">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">{t("Ativação Geral da Integração")}</CardTitle>
              <CardDescription>
                {t(
                  "Controle mestre. Se estiver desativado, nenhuma chamada ao Bling será feita pelo CRM ou pelas IAs.",
                )}
              </CardDescription>
            </div>
            <Switch
              checked={isMasterEnabled}
              onCheckedChange={handleToggleMaster}
              disabled={isUpdatingFeatures || !isConnected}
            />
          </div>
        </CardHeader>
      </Card>

      {/* Card 2: Credenciais da API v3 */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("Credenciais da API v3 do Bling")}</CardTitle>
          <CardDescription>
            {t(
              "Cadastre o seu aplicativo criado no painel de desenvolvedor do Bling (Configurações › Integrações › API).",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSalvarCredenciais} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="client_id">{t("Client ID")}</Label>
                <Input
                  id="client_id"
                  placeholder="Ex: 8a4c8f2b..."
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="client_secret">{t("Client Secret")}</Label>
                <Input
                  id="client_secret"
                  type="password"
                  placeholder={config?.client_id ? t("•••••••••••••••• (Inalterado)") : t("Cole o Secret do Bling")}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="access_token">{t("Access Token ou Token de Integração Direta (Opcional)")}</Label>
              <Input
                id="access_token"
                type="password"
                placeholder={isConnected ? t("•••••••••••••••• (Token já ativo)") : t("Cole o token se gerado manualmente")}
                value={accessTokenManual}
                onChange={(e) => setAccessTokenManual(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Todos os tokens são armazenados com criptografia simétrica AES-256 no banco e nunca são exibidos de volta.",
                )}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              {Boolean(config?.client_id) && !isConnected && (
                <Button
                  asChild
                  type="button"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <a href="/api/v1/integrations/bling/connect">
                    {t("Autorizar Conexão no Bling")}
                  </a>
                </Button>
              )}
              <Button type="submit" variant={config?.client_id && !isConnected ? "outline" : "default"} disabled={isSavingCreds}>
                {isSavingCreds ? t("Salvando...") : t("Salvar Credenciais")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Card 3: Funcionalidades Modulares Independentes */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("Módulos & Funcionalidades Independentes")}</CardTitle>
          <CardDescription>
            {t(
              "Ative ou desative cada função individualmente de acordo com a necessidade da sua operação.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 divide-y divide-border/40">
            {/* Clientes */}
            <div className="flex items-center justify-between pt-3 first:pt-0">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("Sincronização de Clientes / Contatos")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Cria e atualiza automaticamente os contatos no Bling com dados cadastrais e fiscais.")}
                </p>
              </div>
              <Switch
                checked={features.sync_contacts}
                onCheckedChange={(checked) => handleToggleFeature("sync_contacts", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Produtos & Catálogo */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">{t("Sincronização de Produtos & Catálogo")}</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs font-normal"
                    onClick={handleSyncProducts}
                    disabled={isSyncingProducts || !isMasterEnabled || !isConnected}
                  >
                    {isSyncingProducts ? t("Sincronizando...") : t("Sincronizar Produtos Agora")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Sincroniza o catálogo do Bling com o CRM. Mantém os mesmos SKUs para a IA enviar cards no WhatsApp e consultar estoque.",
                  )}
                </p>
              </div>
              <Switch
                checked={features.sync_products}
                onCheckedChange={(checked) => handleToggleFeature("sync_products", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Consulta de Estoque */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("Consulta de Estoque em Tempo Real (IA & Vendas)")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Permite que o Agente de IA e os atendentes consultem o saldo físico e virtual de produtos no Bling.")}
                </p>
              </div>
              <Switch
                checked={features.ai_stock_consult}
                onCheckedChange={(checked) => handleToggleFeature("ai_stock_consult", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Pedidos de Venda */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("Geração de Pedidos de Venda no Bling")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Gera pedidos no Bling quando a oportunidade for ganha ou movida para a etapa de faturamento.")}
                </p>
              </div>
              <Switch
                checked={features.auto_create_order}
                onCheckedChange={(checked) => handleToggleFeature("auto_create_order", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Emissão de NF-e */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">{t("Emissão & Autorização de Notas Fiscais (NF-e)")}</Label>
                  <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/40">
                    {t("Exige Conferência")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("Cria rascunhos de nota fiscal no Bling prontos para transmissão à SEFAZ.")}
                </p>
              </div>
              <Switch
                checked={features.invoice_emission}
                onCheckedChange={(checked) => handleToggleFeature("invoice_emission", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Rastreio */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("Notificações de Rastreio & Envio")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Dispara mensagens no WhatsApp do cliente assim que o Bling registrar o código de rastreamento.")}
                </p>
              </div>
              <Switch
                checked={features.tracking_notifications}
                onCheckedChange={(checked) => handleToggleFeature("tracking_notifications", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Financeiro */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t("Integração Financeira (Boletos & Pix)")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("Emite e sincroniza cobranças e faturas registradas no pedido do Bling.")}
                </p>
              </div>
              <Switch
                checked={features.financial_bills}
                onCheckedChange={(checked) => handleToggleFeature("financial_bills", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>

            {/* Agente de IA Fiscal */}
            <div className="flex items-center justify-between pt-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label className="text-sm font-medium">{t("Agente de IA Fiscal Inteligente")}</Label>
                  <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/40">
                    {t("WhatsApp")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("A IA solicita e valida CPF/CNPJ e CEP de forma humanizada no chat antes do fechamento.")}
                </p>
              </div>
              <Switch
                checked={features.ai_fiscal_agent}
                onCheckedChange={(checked) => handleToggleFeature("ai_fiscal_agent", checked)}
                disabled={isUpdatingFeatures || !isMasterEnabled}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Card: URL do Webhook do Bling */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("URL de Webhook Inbound (Bling ERP)")}</CardTitle>
          <CardDescription>
            {t(
              "Cadastre este endereço no painel do Bling (Configurações › Integrações › Webhooks) para receber atualizações de pedidos, emissão de NF-e e rastreamentos em tempo real.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={
                config?.organization_id
                  ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/webhooks/bling/${config.organization_id}`
                  : t("Carregando URL...")
              }
              className="font-mono text-xs bg-muted/50 select-all"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = `${window.location.origin}/api/v1/webhooks/bling/${config?.organization_id}`;
                navigator.clipboard.writeText(url);
                toast.success(t("URL do Webhook copiada para a área de transferência!"));
              }}
            >
              {t("Copiar")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Gatilhos recomendados no Bling: 'Alteração na situação de pedidos', 'Emissão de Notas Fiscais' e 'Atualização de Rastreamento de Encomendas'.",
            )}
          </p>
        </CardContent>
      </Card>

      {/* Card 4: Histórico de Logs e Sincronização */}
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t("Auditoria & Logs de Sincronização")}</CardTitle>
          <CardDescription>
            {t("Histórico das últimas operações realizadas com a API do Bling.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground border rounded-md border-dashed">
              {t("Nenhum log registrado ainda.")}
            </div>
          ) : (
            <div className="rounded-md border divide-y overflow-hidden text-xs">
              {logs.map((log) => (
                <div key={log.id} className="flex items-center justify-between p-3 bg-card/40">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{log.operation}</span>
                      <Badge
                        variant={log.status === "success" ? "default" : "destructive"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {log.status === "success" ? t("Sucesso") : t("Falha")}
                      </Badge>
                    </div>
                    {log.error_message && (
                      <p className="text-destructive text-[11px] font-mono">{log.error_message}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground text-[11px]">
                    {new Date(log.created_at).toLocaleString("pt-BR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
