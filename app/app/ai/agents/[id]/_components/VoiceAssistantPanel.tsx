"use client";

import * as React from "react";
import type { Conversation } from "@elevenlabs/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import {
  voiceSettingsSchema,
  type VoicePanelData,
  type VoiceSettings,
} from "@/lib/ai/voice/schema";

export function VoiceAssistantPanel({
  agentId,
  readOnly = false,
}: {
  agentId: string;
  readOnly?: boolean;
}) {
  const t = useT();
  const endpoint = `/api/v1/ai/agents/${agentId}/voice`;
  const [data, setData] = React.useState<VoicePanelData | null>(null);
  const [settings, setSettings] = React.useState<VoiceSettings | null>(null);
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [callStatus, setCallStatus] = React.useState<
    "idle" | "connecting" | "listening" | "speaking"
  >("idle");
  const [transcript, setTranscript] = React.useState<{ role: string; text: string }[]>([]);
  const session = React.useRef<Conversation | null>(null);
  const generation = React.useRef(0);
  const mounted = React.useRef(true);
  const mutation = React.useRef(false);
  const showError = (err: unknown) =>
    setError(
      err instanceof ApiError
        ? err.message
        : t("Não foi possível concluir. Confira sua conexão e tente novamente."),
    );

  const load = React.useCallback(
    async (replaceSettings = true) => {
      const result = await apiClient.get<{ data: VoicePanelData }>(endpoint, { timeoutMs: 35000 });
      if (mounted.current) {
        setData(result.data);
        if (replaceSettings) setSettings(result.data.settings);
      }
    },
    [endpoint],
  );

  React.useEffect(() => {
    mounted.current = true;
    if (!readOnly) {
      // The state update happens after the network response, not during the effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load().catch((err) => {
        if (mounted.current)
          setError(
            err instanceof ApiError
              ? err.message
              : "Não foi possível carregar o assistente de voz.",
          );
      });
    }
    return () => {
      mounted.current = false;
      // This is a lifecycle generation counter, not a DOM ref snapshot.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      const current = session.current;
      session.current = null;
      if (current)
        void current.endSession().catch(() => {
          /* SDK also closes on page unload. */
        });
    };
  }, [load, readOnly]);

  const stop = async () => {
    generation.current++;
    const current = session.current;
    session.current = null;
    try {
      await current?.endSession();
    } catch {
      if (mounted.current)
        setError(
          t(
            "Não foi possível confirmar o encerramento. Feche esta aba para interromper o microfone.",
          ),
        );
    } finally {
      if (mounted.current) setCallStatus("idle");
    }
  };
  const save = async (credential: boolean) => {
    if (mutation.current || readOnly || callStatus !== "idle") return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.post(
        endpoint,
        credential ? { action: "credential", api_key: key } : { action: "configure", settings },
        { timeoutMs: 120000 },
      );
      if (!mounted.current) return;
      if (credential) setKey("");
      await load(!credential);
      setNotice(
        t(
          credential
            ? "Conta conectada. Agora escolha como seu assistente deve falar."
            : "Assistente de voz salvo. Você já pode conversar com ele aqui.",
        ),
      );
    } catch (err) {
      if (mounted.current) {
        showError(err);
        // Refresh only status: uncertain creation is recoverable and the local
        // choices must remain visible while the provider confirms it.
        void load(false).catch(() => {
          /* Keep the original, actionable failure visible. */
        });
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const dirty = !!settings && JSON.stringify(settings) !== JSON.stringify(data?.settings);
  const start = async () => {
    if (callStatus !== "idle" || mutation.current || readOnly || !data?.configured || dirty) return;
    const attempt = ++generation.current;
    const current = () => mounted.current && attempt === generation.current;
    setError(null);
    setNotice(null);
    setTranscript([]);
    setCallStatus("connecting");
    try {
      const response = await apiClient.post<{ data: { signed_url: string } }>(
        endpoint,
        { action: "test" },
        { timeoutMs: 60000 },
      );
      if (!current()) return;
      const { Conversation: sdk } = await import("@elevenlabs/client");
      if (!current()) return;
      const conversation = await sdk.startSession({
        signedUrl: response.data.signed_url,
        connectionType: "websocket",
        onConnect: () => {
          if (current()) setCallStatus("listening");
        },
        onDisconnect: () => {
          if (current()) {
            session.current = null;
            setCallStatus("idle");
          }
        },
        onModeChange: ({ mode }) => {
          if (current()) setCallStatus(mode);
        },
        onMessage: ({ role, message }) => {
          if (current()) setTranscript((items) => [...items.slice(-49), { role, text: message }]);
        },
        onError: () => {
          if (current())
            setError(
              t(
                "O teste de voz encontrou uma falha. Encerre e tente novamente; confira a permissão do microfone e o saldo da conta.",
              ),
            );
        },
        onMCPToolApprovalRequest: () => false,
      });
      if (!current()) {
        await conversation.endSession();
        return;
      }
      session.current = conversation;
    } catch (err) {
      if (current()) {
        setCallStatus("idle");
        setError(
          err instanceof ApiError
            ? err.message
            : t(
                "Não foi possível iniciar a voz. Permita o microfone neste site e confira sua conexão.",
              ),
        );
      }
    }
  };

  if (readOnly)
    return (
      <section id="voice-assistant" className="rounded-xl border p-6">
        {t("Um administrador pode configurar e testar o assistente de voz.")}
      </section>
    );
  const disabled = busy || callStatus !== "idle";
  const field = (patch: Partial<VoiceSettings>) =>
    setSettings((previous) => (previous ? { ...previous, ...patch } : previous));
  return (
    <section
      id="voice-assistant"
      aria-label={t("Assistente de voz")}
      className="space-y-6 rounded-xl border bg-card p-6"
    >
      <header>
        <h2 className="text-lg font-semibold">{t("Assistente de voz")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Escolha a voz, ajuste a abertura e converse com seu assistente antes de usá-lo.")}
        </p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
      {!data && (
        <Button variant="outline" disabled={busy} onClick={() => void load().catch(showError)}>
          {t("Carregar configuração")}
        </Button>
      )}
      {data && (
        <>
          <details open={!data.credential_configured} className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              {data.provider_label} ·{" "}
              {t(data.credential_configured ? "Conta conectada" : "Conectar conta")}
            </summary>
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                {t(
                  "A chave fica protegida no CRM e é usada pelos assistentes de voz desta organização.",
                )}
              </p>
              <Label htmlFor="voice-api-key">{t("Chave da API")}</Label>
              <Input
                id="voice-api-key"
                type="password"
                autoComplete="new-password"
                value={key}
                disabled={disabled}
                onChange={(e) => setKey(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-4">
                <Button
                  variant="outline"
                  disabled={disabled || key.trim().length < 10}
                  onClick={() => void save(true)}
                >
                  {t(busy ? "Conectando…" : "Salvar chave e conectar")}
                </Button>
                <a
                  href="https://elevenlabs.io/app/settings/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {t("Obter chave na ElevenLabs")}
                </a>
              </div>
            </div>
          </details>
          {settings && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
              <div className="space-y-4">
                {data.voices_error && (
                  <p role="alert" className="text-sm text-destructive">
                    {data.voices_error}
                  </p>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="assistant-voice">{t("Voz")}</Label>
                    <select
                      id="assistant-voice"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={settings.voice_id}
                      disabled={disabled || !data.credential_configured}
                      onChange={(e) => field({ voice_id: e.target.value })}
                    >
                      <option value="">{t("Escolha uma voz da sua conta")}</option>
                      {settings.voice_id &&
                        !data.voices.some((v) => v.id === settings.voice_id) && (
                          <option value={settings.voice_id}>
                            {t("Voz salva · indisponível na lista")}
                          </option>
                        )}
                      {data.voices.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="voice-language">{t("Idioma")}</Label>
                    <select
                      id="voice-language"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={settings.language}
                      disabled={disabled}
                      onChange={(e) =>
                        field({ language: e.target.value as VoiceSettings["language"] })
                      }
                    >
                      <option value="pt">{t("Português")}</option>
                      <option value="en">English</option>
                      <option value="es">Español</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="voice-opening">{t("Primeira mensagem")}</Label>
                  <Textarea
                    id="voice-opening"
                    value={settings.first_message}
                    maxLength={1000}
                    disabled={disabled}
                    onChange={(e) => field({ first_message: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="voice-instructions">
                    {t("Como o assistente deve conversar")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Começamos com as instruções salvas do agente. Os ajustes abaixo valem para a voz; ferramentas e materiais do CRM não são usados neste teste.",
                    )}
                  </p>
                  <Textarea
                    id="voice-instructions"
                    className="min-h-48"
                    value={settings.system_prompt}
                    maxLength={15000}
                    disabled={disabled}
                    onChange={(e) => field({ system_prompt: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="voice-duration">{t("Duração máxima do teste")}</Label>
                  <select
                    id="voice-duration"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={settings.max_duration_seconds}
                    disabled={disabled}
                    onChange={(e) => field({ max_duration_seconds: Number(e.target.value) })}
                  >
                    {[60, 180, 300, 600].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds / 60} {t("minutos")}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  disabled={
                    disabled ||
                    !data.credential_configured ||
                    !voiceSettingsSchema.safeParse(settings).success
                  }
                  onClick={() => void save(false)}
                >
                  {t(
                    busy
                      ? "Salvando assistente…"
                      : data.status === "creating" || data.status === "syncing"
                        ? "Recuperar e salvar configuração"
                        : "Salvar assistente de voz",
                  )}
                </Button>
              </div>
              <div className="space-y-4 self-start rounded-xl bg-muted/40 p-5">
                <h3 className="font-semibold">{t("Converse com seu assistente")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "Use seu microfone. O teste consome créditos da ElevenLabs. O áudio não é gravado; a transcrição fica no provedor por até 7 dias.",
                  )}
                </p>
                <p role="status" className="text-sm font-medium">
                  {t(
                    callStatus === "connecting"
                      ? "Conectando e preparando o microfone…"
                      : callStatus === "speaking"
                        ? "Assistente falando"
                        : callStatus === "listening"
                          ? "Ouvindo você"
                          : dirty
                            ? "Salve as alterações para testar esta versão."
                            : data.configured
                              ? "Pronto para testar"
                              : "Salve a configuração para começar.",
                  )}
                </p>
                {callStatus === "idle" ? (
                  <Button disabled={busy || !data.configured || dirty} onClick={() => void start()}>
                    {t("Testar com meu microfone")}
                  </Button>
                ) : (
                  <Button variant="destructive" onClick={() => void stop()}>
                    {t("Encerrar teste")}
                  </Button>
                )}
                <div
                  role="log"
                  aria-label={t("Conversa do teste de voz")}
                  className="max-h-96 space-y-3 overflow-auto"
                >
                  {transcript.map((message, index) => (
                    <p key={index} className="rounded-lg bg-background p-3 text-sm">
                      <strong>{t(message.role === "user" ? "Você" : "Assistente")}: </strong>
                      {message.text}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
