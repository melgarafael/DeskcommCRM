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
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar um número pelo parceiro que espelha a Cloud API — recorte do PR
 * #1130, de @vgamkt. Só aparece quando a instalação liga o canal (a aba nem é
 * montada sem isso; ver `ConexoesShell`).
 *
 * A marca vem do servidor (`label`): a tela não pode nomear provider
 * (`lint:channels`), e quem instala reconhece o nome do serviço que contratou.
 *
 * ─── Duas pontas, na ordem em que dá errado ─────────────────────────────────
 *
 * 1. O token: o servidor descobre o número e a conta sozinho e valida antes de
 *    gravar. Com ele o CRM ENVIA.
 * 2. O webhook: a URL daqui vai para o painel do provedor, e o segredo de
 *    assinatura de lá vem para cá. Sem os dois o CRM envia mas NÃO RECEBE — e a
 *    tela diz isso em voz alta, em vez de deixar o operador descobrir pela
 *    resposta do cliente que nunca chegou.
 */

const ROTA = "/api/v1/channels/graph-partner";

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  has_token: boolean;
  has_signing_secret: boolean;
  phone_number_id: string | null;
  waba_id: string | null;
  display_name: string | null;
  phone_number: string | null;
  status: string | null;
  webhook_url: string | null;
}

/** Campo somente-leitura com botão de copiar — o que o operador cola do outro lado. */
function ParaColar({ rotulo, valor }: { rotulo: string; valor: string }) {
  const t = useT();
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

export function CanalGraphParceiroClient() {
  const t = useT();
  const qc = useQueryClient();
  // Falha de leitura não trava a tela: sem estado, o formulário continua servindo.
  const { data: estado = null } = useQuery({
    queryKey: ["canal-graph-parceiro"],
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  const [token, setToken] = useState("");
  const [segredo, setSegredo] = useState("");
  const [salvando, setSalvando] = useState<"token" | "segredo" | null>(null);

  const carregar = () => qc.invalidateQueries({ queryKey: ["canal-graph-parceiro"] });

  const conectar = async () => {
    setSalvando("token");
    try {
      await apiClient.post(ROTA, { token });
      // O token sai da memória da tela assim que é gravado: ele não volta num GET.
      setToken("");
      toast.success(t("Canal conectado."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setSalvando(null);
    }
  };

  const gravarSegredo = async () => {
    setSalvando("segredo");
    try {
      await apiClient.patch(ROTA, { signing_secret: segredo });
      setSegredo("");
      toast.success(t("Segredo gravado. O canal passa a receber mensagens."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível gravar o segredo."));
    } finally {
      setSalvando(null);
    }
  };

  const rotulo = estado?.label ?? t("provedor parceiro");
  const conectado = estado?.connected ?? false;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-graph-parceiro">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("Conectar por")} {rotulo}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Um número oficial (WhatsApp Business) por um parceiro homologado pela Meta. Você cola só o token: o número e a conta são descobertos sozinhos.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

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
          <Label htmlFor="graph-parceiro-token">{t("Token de acesso")}</Label>
          <Input
            id="graph-parceiro-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={estado?.has_token ? t("gravada — preencha para trocar") : "sk_live_…"}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.",
            )}
          </p>
        </div>

        <div>
          <Button onClick={conectar} disabled={salvando !== null || token.trim().length < 20}>
            {salvando === "token" ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("A credencial é testada contra o provedor antes de ser gravada.")}
          </p>
        </div>
      </Card>

      {/* Só depois de conectar: antes disso não há URL a mostrar, e um passo 2
          vazio faz parecer que falta algo que ainda não podia existir. */}
      {conectado && estado?.webhook_url && (
        <Card
          className={
            estado.has_signing_secret
              ? "flex flex-col gap-4 p-4"
              : "flex flex-col gap-4 border-warning/40 bg-warning-bg p-4"
          }
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("Receber as respostas")}</h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "No painel do provedor, cole a URL abaixo no webhook do número e ative a assinatura. Depois cole aqui o segredo que o painel mostrar. Sem o segredo o CRM envia, mas recusa tudo o que chega — a resposta do cliente não entra.",
                )}
              </p>
            </div>
            {estado.has_signing_secret ? (
              <Badge variant="secondary">{t("Recebendo")}</Badge>
            ) : (
              <Badge variant="outline">{t("Não recebe")}</Badge>
            )}
          </div>

          <ParaColar rotulo={t("URL do webhook")} valor={estado.webhook_url} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="graph-parceiro-segredo">{t("Segredo de assinatura")}</Label>
            <Input
              id="graph-parceiro-segredo"
              type="password"
              value={segredo}
              onChange={(e) => setSegredo(e.target.value)}
              placeholder={estado.has_signing_secret ? t("gravada — preencha para trocar") : "whsec_…"}
              autoComplete="off"
            />
          </div>
          <div>
            <Button
              variant="outline"
              onClick={gravarSegredo}
              disabled={salvando !== null || !segredo.trim().startsWith("whsec_")}
            >
              {salvando === "segredo" ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
