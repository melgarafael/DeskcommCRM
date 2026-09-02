/**
 * Nuvemshop integration status page.
 *
 * Three states:
 *   1. not_configured — env vars empty: shows "configure env" card.
 *   2. not_connected  — env ok, no tenant_integrations row: shows Connect button.
 *   3. connected      — row exists with status=healthy: shows store info + Disconnect.
 *
 * The Connect Server Action redirects to Nuvemshop's authorize URL. Callback
 * lives at /api/v1/integrations/nuvemshop/callback.
 */

import { Storefront } from "@/lib/ui/icons";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isConfigured } from "@/lib/nuvemshop/config";
import { ConnectButton, DisconnectButton } from "./_components/ConnectButton";
import { StatusToast } from "./_components/StatusToast";
import { Suspense } from "react";

interface IntegrationRow {
  id: string;
  status: string;
  scopes: string[];
  store_metadata: { store_id?: string } | null;
  webhook_subscriptions: Record<string, { id: number | null; error?: string }> | null;
  last_sync_at: string | null;
}

async function loadIntegration(orgId: string): Promise<IntegrationRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("tenant_integrations")
    .select("id, status, scopes, store_metadata, webhook_subscriptions, last_sync_at")
    .eq("organization_id", orgId)
    .eq("provider", "nuvemshop")
    .maybeSingle();
  return (data as IntegrationRow | null) ?? null;
}

export default async function NuvemshopIntegrationPage() {
  const user = await loadAuthUser();
  const activeOrg = user ? await resolveActiveOrg(user) : null;
  const configured = isConfigured();

  const integration =
    activeOrg && configured ? await loadIntegration(activeOrg.orgId) : null;

  const isAdmin = activeOrg?.role === "admin" || user?.is_platform_admin === true;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Suspense fallback={null}>
        <StatusToast />
      </Suspense>

      <header className="flex items-start gap-4">
        <div className="rounded-md border border-border bg-surface p-3">
          <Storefront size={28} weight="duotone" className="text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Nuvemshop</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sincroniza pedidos, produtos e clientes via OAuth + webhooks.
          </p>
        </div>
      </header>

      {!configured ? (
        <Card>
          <CardHeader>
            <CardTitle>Integração não configurada</CardTitle>
            <CardDescription>
              Configure <code className="rounded bg-muted px-1 py-0.5 text-xs">NUVEMSHOP_APP_ID</code>,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">NUVEMSHOP_CLIENT_ID</code> e{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">NUVEMSHOP_CLIENT_SECRET</code>{" "}
              em <code className="rounded bg-muted px-1 py-0.5 text-xs">.env.local</code> para
              ativar a integração.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Obtenha as credenciais em{" "}
            <a
              className="underline"
              href="https://partners.tiendanube.com/"
              target="_blank"
              rel="noreferrer"
            >
              partners.tiendanube.com
            </a>
            .
          </CardContent>
        </Card>
      ) : !integration || integration.status === "disconnected" ? (
        <Card>
          <CardHeader>
            <CardTitle>Conectar Nuvemshop</CardTitle>
            <CardDescription>
              Você será redirecionado para autorizar o app na sua loja.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ConnectButton disabled={!isAdmin} />
            {!isAdmin ? (
              <p className="text-xs text-muted-foreground">
                Somente administradores podem conectar integrações.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                Conectado
                <Badge variant="secondary">{integration.status}</Badge>
              </CardTitle>
              <CardDescription>
                Loja #{integration.store_metadata?.store_id ?? "—"} · última sync:{" "}
                {integration.last_sync_at
                  ? new Date(integration.last_sync_at).toLocaleString("pt-PT")
                  : "—"}
              </CardDescription>
            </div>
            {isAdmin ? <DisconnectButton /> : null}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <span className="font-medium">Escopos:</span>{" "}
              {integration.scopes.length > 0 ? (
                <span className="text-muted-foreground">{integration.scopes.join(", ")}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div>
              <span className="font-medium">Webhooks registrados:</span>{" "}
              <span className="text-muted-foreground">
                {integration.webhook_subscriptions
                  ? Object.entries(integration.webhook_subscriptions).filter(
                      ([, v]) => v.id !== null,
                    ).length
                  : 0}{" "}
                / 8
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
