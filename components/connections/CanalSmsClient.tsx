"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { nomeDoCanal } from "@/lib/channels/estado";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar um número de SMS (#4415).
 *
 * O operador cola três coisas do painel da conta de SMS: o identificador da
 * conta, a chave e o número. O servidor confere na conta que a chave vale e que
 * o número é dela ANTES de gravar, e aponta o recebimento do número para cá.
 *
 * O registro de remetente dos EUA (A2P 10DLC) acontece no fornecedor, antes:
 * sem ele as operadoras bloqueiam o envio. A tela diz isso logo no começo,
 * porque é a primeira coisa que trava quem atende os EUA.
 *
 * A tela não nomeia o fornecedor (`lint:channels`): ela fala da "conta de SMS".
 * Os nomes dos campos (Account SID, Auth Token) são os que aparecem no painel,
 * para o operador achar o que copiar.
 */

const ROTA = "/api/v1/channels/sms";

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: string | null;
  webhook_url: string | null;
}

interface Conexao {
  webhook_url: string | null;
  receiving_configured: boolean;
}

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{rotulo}</span>
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

export function CanalSmsClient() {
  const t = useT();
  // O exemplo do campo segue o país da organização, como em toda tela.
  const telefoneExemplo = useTelefoneExemplo();
  const qc = useQueryClient();
  const { data: estado = null } = useQuery({
    queryKey: ["canal-sms"],
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  const [conta, setConta] = useState("");
  const [chave, setChave] = useState("");
  const [numero, setNumero] = useState("");
  const [salvando, setSalvando] = useState(false);
  // Resultado da última conexão desta tela: se o recebimento não foi apontado
  // sozinho, o aviso fica até o operador sair da página.
  const [recebimentoApontado, setRecebimentoApontado] = useState<boolean | null>(null);

  const conectar = async () => {
    setSalvando(true);
    try {
      const r = await apiClient.post<{ data: Conexao }>(ROTA, {
        account_sid: conta.trim(),
        auth_token: chave.trim(),
        phone_number: numero.trim(),
      });
      setChave("");
      setRecebimentoApontado(r.data.receiving_configured);
      toast.success(t("Canal conectado."));
      await qc.invalidateQueries({ queryKey: ["canal-sms"] });
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(false);
    }
  };

  const conectado = estado?.connected ?? false;
  const prontoParaConectar =
    /^AC[0-9a-f]{32}$/i.test(conta.trim()) && chave.trim().length >= 16 && /^\+[1-9]\d{7,14}$/.test(numero.trim());

  return (
    <div className="flex flex-col gap-4" data-testid="canal-sms">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{t("Conectar um número de SMS")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Para atender por SMS quem não usa WhatsApp. As mensagens entram na Inbox no mesmo contato, e a IA, os follow-ups e as automações respondem por SMS.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t(
            "Nos EUA, o número precisa estar registrado para envio comercial (A2P 10DLC) na conta de SMS antes de conectar — sem isso as operadoras bloqueiam as mensagens. Cada SMS é cobrado pela conta de SMS, por parte de 160 caracteres (70 com emoji ou acento).",
          )}
        </p>

        {conectado && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{nomeDoCanal(estado ?? {}, t)}</p>
            <p className="text-xs text-muted-foreground">
              {estado?.phone_number ?? t("sem número informado")} · {estado?.status ?? "—"}
            </p>
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sms-conta">{t("Account SID")}</Label>
          <Input
            id="sms-conta"
            value={conta}
            onChange={(e) => setConta(e.target.value)}
            placeholder="AC…"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sms-chave">{t("Auth Token")}</Label>
          <Input
            id="sms-chave"
            type="password"
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={conectado ? t("gravada — preencha para trocar") : ""}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t("Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sms-numero">{t("Número de SMS")}</Label>
          <Input
            id="sms-numero"
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            placeholder={telefoneExemplo}
            autoComplete="off"
            inputMode="tel"
          />
        </div>

        <div>
          <Button onClick={conectar} disabled={salvando || !prontoParaConectar}>
            {salvando ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("A conta e o número são conferidos na conta de SMS antes de gravar.")}
          </p>
        </div>
      </Card>

      {conectado && estado?.webhook_url && (
        <Card
          className={
            recebimentoApontado === false
              ? "flex flex-col gap-4 border-warning/40 bg-warning-bg p-4"
              : "flex flex-col gap-4 p-4"
          }
        >
          <div>
            <h3 className="text-sm font-semibold">{t("Receber as respostas")}</h3>
            <p className="text-xs text-muted-foreground">
              {recebimentoApontado === false
                ? t(
                    "Não foi possível apontar o recebimento do número sozinho. No painel da conta de SMS, cole a URL abaixo em “A message comes in” do número. Sem isso o CRM envia, mas a resposta do cliente não entra.",
                  )
                : t(
                    "O número já foi apontado para cá ao conectar. Se ele estiver num Messaging Service, cole a URL abaixo na integração do serviço, ou escolha “Defer to sender's webhook”.",
                  )}
            </p>
          </div>
          <ParaColar rotulo={t("URL do webhook")} valor={estado.webhook_url} />
        </Card>
      )}
    </div>
  );
}
