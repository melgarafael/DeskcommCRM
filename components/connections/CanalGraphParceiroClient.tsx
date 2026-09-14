"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useConnectGraphPartnerChannel,
  useGraphPartnerChannel,
} from "@/hooks/channels/useGraphPartnerChannel";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ParaIntegrar } from "./ParaIntegrar";

/** Campo somente-leitura com botão de copiar — o que o operador cola no painel. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  const t = useT();
  if (!valor) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {rotulo}
        </span>
        <span className="text-sm text-destructive">
          {t("não configurado nesta instalação — defina no servidor antes de continuar")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{valor}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Conexão do parceiro Graph-compatível: só o token. O servidor chama `/me` e
 * descobre o número e a WABA — o operador não precisa de id nenhum.
 *
 * O rótulo da marca vem do servidor; este componente não nomeia o provider (o
 * `lint:channels` reprova), só o conceito.
 */
export function CanalGraphParceiroClient() {
  const t = useT();
  const { data, isPending } = useGraphPartnerChannel();
  const conectar = useConnectGraphPartnerChannel();
  const [token, setToken] = useState("");

  const estado = data?.data;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const r = await conectar.mutateAsync({ token });
    toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
    setToken("");
  }

  if (isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-graph-parceiro-root">
      {estado?.connected ? (
        <Card className="p-4" data-testid="canal-conectado">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{estado.displayName}</span>
            {estado.phoneNumber ? (
              <Badge variant="outline" className="font-mono text-xs">
                {estado.phoneNumber}
              </Badge>
            ) : null}
            <Badge>{estado.status ?? "—"}</Badge>
            <Badge variant={estado.hasToken ? "outline" : "destructive"}>
              {estado.hasToken ? t("credencial guardada") : t("sem credencial")}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            WABA <span className="font-mono">{estado.wabaId}</span> · {t("número")}{" "}
            <span className="font-mono">{estado.phoneNumberId}</span>
          </p>
        </Card>
      ) : null}
      {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

      {estado?.webhook ? (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="font-medium">{t("Cole esta URL no painel do provedor")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "Na aba de Webhooks do número. Sem esse passo o canal envia, mas não recebe — as respostas do cliente não chegam e a janela de 24 horas nunca abre.",
              )}
            </p>
          </div>
          <ParaColar rotulo={t("URL de callback")} valor={estado.webhook.callbackUrl} />
          <p className="text-xs text-muted-foreground">
            {t(
              "A assinatura do webhook é opcional no provedor. Se você a ativar, guarde o segredo no servidor para passar a validar as entregas.",
            )}
          </p>
        </Card>
      ) : null}

      {estado?.connected ? (
        <ParaIntegrar
          campos={[
            { rotulo: t("Endpoint da API"), valor: estado.endpoint ?? null },
            { rotulo: t("ID do número de telefone"), valor: estado.phoneNumberId ?? null },
            { rotulo: t("ID da conta do WhatsApp Business"), valor: estado.wabaId ?? null },
          ]}
          ajuda={
            <div className="space-y-1.5">
              <p>
                {t(
                  "O token está no painel do provedor (começa com sk_) — este CRM não o gera nem o exibe de volta.",
                )}
              </p>
              <p>
                {t(
                  "O webhook de um número aponta para um só destino. Para os dois CRMs receberem ao mesmo tempo, um deles precisa reencaminhar as mensagens ao outro.",
                )}
              </p>
            </div>
          }
          aviso={
            <>
              {t("Um número tem um único webhook.")}{" "}
              {t("Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.")}
            </>
          }
        />
      ) : null}

      <Card className="p-4">
        <h2 className="font-medium">
          {estado?.connected ? t("Trocar token") : t("Conectar provedor parceiro")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Cole o token do provedor (começa com sk_). O número e a conta são descobertos automaticamente. O token é validado antes de ser gravado — se não responder, nada é salvo.",
          )}
        </p>

        <form onSubmit={enviar} className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="graph-partner-token">{t("Token de acesso")}</Label>
            <Input
              id="graph-partner-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={estado?.hasToken ? t("•••• (já guardado — preencha para trocar)") : "sk_live_…"}
              required
            />
            <span className="text-xs text-muted-foreground">
              {t("Guardado cifrado. Não é exibido de volta em nenhum momento.")}
            </span>
          </div>
          <Button type="submit" disabled={conectar.isPending} data-testid="btn-conectar">
            {conectar.isPending ? t("Validando com o provedor…") : t("Validar e conectar")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
