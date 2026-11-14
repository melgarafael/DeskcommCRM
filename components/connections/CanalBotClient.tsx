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
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar o robô de mensagens (#3486, proposta #3440). Só aparece quando a
 * instalação liga o módulo `canal_bot` (a aba nem é montada sem isso; ver
 * `ConexoesShell`).
 *
 * Um passo só: o token do robô. O servidor confere o token, registra a URL de
 * entrega no fornecedor e só então grava — não há segundo passo de webhook para
 * esquecer (ver `app/api/v1/channels/bot/route.ts`). O nome do serviço vem do
 * servidor, porque a tela não pode nomear provider (`lint:channels`).
 */

const ROTA = "/api/v1/channels/bot";

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  bot_id: string | null;
  display_name: string | null;
  status: string | null;
  has_token: boolean;
  webhook_url: string | null;
}

export function CanalBotClient() {
  const t = useT();
  const qc = useQueryClient();
  // Falha de leitura não trava a tela: sem estado, o formulário continua servindo.
  const { data: estado = null } = useQuery({
    queryKey: ["canal-bot"],
    queryFn: async () => (await apiClient.get<{ data: Estado }>(ROTA)).data,
  });
  const [token, setToken] = useState("");
  const [ocupado, setOcupado] = useState<"conectar" | "desconectar" | null>(null);

  const carregar = () => qc.invalidateQueries({ queryKey: ["canal-bot"] });
  const conectado = estado?.connected ?? false;

  const conectar = async () => {
    setOcupado("conectar");
    try {
      await apiClient.post(ROTA, { token });
      // O token sai da memória da tela assim que é gravado: ele não volta num GET.
      setToken("");
      toast.success(t("Robô conectado. As conversas privadas com ele chegam ao Inbox."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setOcupado(null);
    }
  };

  const desconectar = async () => {
    if (!estado?.channel_session_id) return;
    setOcupado("desconectar");
    try {
      await apiClient.delete(`/api/v1/channel-sessions/${estado.channel_session_id}`);
      toast.success(t("Robô desconectado."));
      await carregar();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível desconectar."));
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="canal-bot">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("Conectar um robô")} {estado?.label ? `(${estado.label})` : ""}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Crie o robô no @BotFather e cole aqui o token que ele mostrar. As conversas privadas com o robô chegam ao Inbox, e a resposta sai pelo mesmo robô. Grupos e campanhas não passam por ele.",
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
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <div>
              <p className="font-medium" data-testid="canal-bot-nome">
                {estado?.display_name ?? "—"}
              </p>
              <p className="text-xs text-muted-foreground">{estado?.status ?? "—"}</p>
            </div>
            <Button variant="outline" size="sm" onClick={desconectar} disabled={ocupado !== null}>
              {ocupado === "desconectar" ? t("Desconectando…") : t("Desconectar")}
            </Button>
          </div>
        )}

        {estado?.channel_session_id && conectado && <ChannelAiAccess channelId={estado.channel_session_id} phoneTesting={false} />}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="canal-bot-token">{t("Token do robô")}</Label>
          <Input
            id="canal-bot-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={estado?.has_token ? t("gravada — preencha para trocar") : "123456789:AA…"}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t("Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.")}
          </p>
        </div>

        <div>
          <Button onClick={conectar} disabled={ocupado !== null || token.trim().length < 20}>
            {ocupado === "conectar" ? t("Verificando…") : conectado ? t("Reconectar") : t("Conectar")}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("O token é testado contra o serviço antes de ser gravado, e a entrega das mensagens é registrada no mesmo passo.")}
          </p>
        </div>
      </Card>
    </div>
  );
}
