"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoEstadoDoCanal } from "@/lib/channels/estado";
import { lerModoDeAcessoDaIa } from "@/lib/ai/elegibilidade/pre-go-live";

interface SocialState {
  label: string;
  configured: boolean;
  webhook_ready: boolean;
  webhook_url: string | null;
  last_event_at: string | null;
  last_test_at: string | null;
  channels: {
    id: string;
    display_name: string;
    status: string;
    social_network: string;
    metadata: unknown;
  }[];
}

export function CanaisSociaisClient() {
  const t = useT();
  const cache = useQueryClient();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [since, setSince] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["social-connections"],
    queryFn: () => apiClient.get<{ data: SocialState }>("/api/v1/channels/social"),
    refetchInterval: 15_000,
  });
  const state = query.data?.data;
  async function run(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await apiClient.post<{
        data: { url?: string; next_before?: string | null; has_more?: boolean; recovered?: number };
      }>("/api/v1/channels/social", body);
      if (body.action === "save") setKey("");
      if (body.action === "recover")
        setCursor(result.data.has_more ? (result.data.next_before ?? null) : null);
      await cache.invalidateQueries({ queryKey: ["social-connections"] });
      if (result.data.url) window.location.assign(result.data.url);
      else
        toast.success(
          body.action === "test"
            ? t("Teste solicitado. Aguarde a confirmação de recebimento nesta tela.")
            : t("Configuração atualizada."),
        );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Não foi possível concluir."));
    } finally {
      setBusy(false);
    }
  }
  async function access(channel: SocialState["channels"][number]) {
    setBusy(true);
    try {
      await apiClient.patch(`/api/v1/channel-sessions/${channel.id}/ai-access`, {
        mode: lerModoDeAcessoDaIa(channel.metadata) === "open" ? "pre_go_live" : "open",
        test_phone_numbers: [],
      });
      await cache.invalidateQueries({ queryKey: ["social-connections"] });
      toast.success(t("Acesso da IA atualizado."));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("Não foi possível concluir."));
    } finally {
      setBusy(false);
    }
  }
  if (query.isPending) return <p>{t("Carregando conexões…")}</p>;
  if (query.isError || !state)
    return (
      <div role="alert">
        <p>{t("Não foi possível carregar as conexões sociais.")}</p>
        <Button onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button>
      </div>
    );
  return (
    <section className="space-y-6 rounded-xl border p-6">
      <header>
        <h2 className="text-xl font-semibold">{t("Instagram e Facebook Messenger")}</h2>
        <p className="text-sm text-muted-foreground">
          {state.label} · {t("Mensagens diretas no inbox, com atendimento humano e IA.")}
        </p>
      </header>
      <form
        className="max-w-xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ action: "save", api_key: key });
        }}
      >
        <Label htmlFor="social-key">{t("Chave de subconta")}</Label>
        <Input
          id="social-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            state.configured
              ? t("Chave cadastrada — preencha para substituir")
              : t("Cole a chave fornecida para esta empresa")
          }
        />
        <p className="text-xs text-muted-foreground">
          {t("Use uma subconta exclusiva desta empresa. A chave fica cifrada no servidor.")}
        </p>
        <Button type="submit" disabled={busy || key.trim().length < 16}>
          {t("Validar e salvar chave")}
        </Button>
      </form>
      {state.configured && (
        <div className="space-y-3">
          <p>
            {state.webhook_ready
              ? t("Recebimento configurado")
              : t(
                  "Ative o recebimento em um endereço HTTPS público antes de conectar suas contas.",
                )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run({ action: "webhook" })}
            >
              {t("Configurar recebimento")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !state.webhook_ready}
              onClick={() => void run({ action: "test" })}
            >
              {t("Testar recebimento")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void run({ action: "sync" })}>
              {t("Atualizar conexões")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Último evento recebido:")}{" "}
            {state.last_event_at
              ? new Date(state.last_event_at).toLocaleString()
              : t("Nenhum evento recebido ainda")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("Último teste confirmado:")}{" "}
            {state.last_test_at
              ? new Date(state.last_test_at).toLocaleString()
              : t("Nenhum teste confirmado ainda")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !state.webhook_ready}
              onClick={() => void run({ action: "connect", network: "instagram" })}
            >
              {t("Conectar Instagram")}
            </Button>
            <Button
              disabled={busy || !state.webhook_ready}
              onClick={() => void run({ action: "connect", network: "messenger" })}
            >
              {t("Conectar Facebook Messenger")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Você será direcionado ao provedor para autorizar a conta e escolher a página.")}
          </p>
        </div>
      )}
      {state.configured && (
        <form
          className="max-w-xl space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (since)
              void run({
                action: "recover",
                since: new Date(since).toISOString(),
                ...(cursor ? { before: cursor } : {}),
              });
          }}
        >
          <Label htmlFor="social-since">{t("Recuperar DMs recebidas desde")}</Label>
          <Input
            id="social-since"
            type="datetime-local"
            required
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
              setCursor(null);
            }}
          />
          <Button type="submit" variant="outline" disabled={busy || !since}>
            {cursor ? t("Continuar recuperação") : t("Recuperar DMs")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(
              "Mensagens já recebidas não são duplicadas. A recuperação depende da retenção disponível no provedor.",
            )}
          </p>
        </form>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {state.channels.map((channel) => (
          <article className="space-y-3 rounded-lg border p-4" key={channel.id}>
            <h3 className="font-medium">{channel.display_name}</h3>
            <p className="text-sm">
              {channel.social_network === "instagram" ? "Instagram" : "Facebook Messenger"} ·{" "}
              {rotuloDoEstadoDoCanal(channel.status, t)}
            </p>
            <p className="text-sm">
              {lerModoDeAcessoDaIa(channel.metadata) === "open"
                ? t(
                    "IA liberada neste canal. O agente precisa estar publicado e vinculado à conexão.",
                  )
                : t("Atendimento humano disponível. A IA está bloqueada neste canal.")}
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void access(channel)}>
              {lerModoDeAcessoDaIa(channel.metadata) === "open"
                ? t("Bloquear IA neste canal")
                : t("Liberar IA neste canal")}
            </Button>
            <Button
              variant="outline"
              disabled={busy || channel.status === "STOPPED"}
              onClick={() => void run({ action: "disconnect", channel_session_id: channel.id })}
            >
              {t("Desconectar canal")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t(
                "No inbox, use os controles de atendimento para assumir a conversa ou devolvê-la à IA. A janela de resposta fecha 24 horas após a última mensagem do cliente.",
              )}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
