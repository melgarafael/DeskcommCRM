"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface StatusResponse {
  configured: boolean;
  status?: string;
  status_reason?: string | null;
  webhook_url?: string;
  updated_at?: string;
}

export function PaySuiteForm({ isAdmin }: { isAdmin: boolean }) {
  const [carregando, setCarregando] = useState(true);
  const [dados, setDados] = useState<StatusResponse | null>(null);
  const [apiToken, setApiToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    setCarregando(true);
    try {
      const res = await fetch("/api/v1/integrations/paysuite");
      const json = (await res.json()) as { data?: StatusResponse };
      setDados(json.data ?? { configured: false });
    } catch {
      toast.error("Não consegui verificar a configuração do PaySuite.");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  async function salvar() {
    if (apiToken.trim().length < 10 || webhookSecret.trim().length < 10) {
      toast.error("Cole o token de API e o segredo de webhook completos.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/integrations/paysuite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_token: apiToken.trim(), webhook_secret: webhookSecret.trim() }),
      });
      const json = (await res.json()) as { error?: { message?: string }; data?: StatusResponse };
      if (!res.ok) {
        toast.error(json.error?.message ?? "Não consegui salvar.");
        return;
      }
      toast.success("PaySuite configurado.");
      setApiToken("");
      setWebhookSecret("");
      await carregar();
    } catch {
      toast.error("Não consegui falar com o servidor.");
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  return (
    <div className="space-y-6">
      {dados?.configured ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              Configurado
              <Badge variant="secondary">{dados.status}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <span className="font-medium">URL de webhook</span> — cole isto no dashboard do
              PaySuite, em configurações de webhook:
              <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-xs">
                {dados.webhook_url}
              </code>
            </div>
            {dados.status_reason ? (
              <p className="text-warning-fg">{dados.status_reason}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">Nenhuma credencial configurada ainda.</p>
      )}

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{dados?.configured ? "Trocar credenciais" : "Conectar PaySuite"}</CardTitle>
            <CardDescription>
              Pegue o token e o segredo de webhook em Settings › API Access no dashboard do
              PaySuite.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ps-token">Token de API (Bearer)</Label>
              <Input
                id="ps-token"
                type="password"
                autoComplete="off"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ps-secret">Segredo de webhook</Label>
              <Input
                id="ps-secret"
                type="password"
                autoComplete="off"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? "Salvando…" : "Salvar"}
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">
          Somente administradores podem configurar integrações de pagamento.
        </p>
      )}
    </div>
  );
}
