"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import type { ChannelSessionLite } from "./AgentForm";
export function LegacyRecovery({
  agent,
  channels,
  credentials,
  hasVersion,
  readOnly,
}: {
  agent: AgentRow;
  channels: ChannelSessionLite[];
  credentials: CredentialRow[];
  hasVersion: boolean;
  readOnly?: boolean;
}) {
  const t = useT(),
    router = useRouter(),
    [channel, setChannel] = useState(""),
    [provider, setProvider] = useState(""),
    [model, setModel] = useState(agent.model ?? ""),
    [credential, setCredential] = useState(""),
    [busy, setBusy] = useState(false);
  async function recover() {
    setBusy(true);
    try {
      await apiClient.post(`/api/v1/ai/agents/${agent.id}/reconcile`, {
        channel_id: channel,
        provider,
        model,
        credential_id: credential || null,
      });
      router.refresh();
    } catch (e) {
      showApiError(e);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4"
      aria-label={t("Recuperar agente legado")}
    >
      <h2 className="font-medium">
        {t("Este agente precisa concluir a configuração para atender.")}
      </h2>
      <p className="text-sm">
        {t(
          "O prompt e o conhecimento serão preservados. Nenhuma permissão para alterar negócios ou agenda será adicionada.",
        )}
      </p>
      {hasVersion ? (
        <p className="text-sm">
          {t("Já existe uma versão preservada. Revise, teste e publique pelo editor abaixo.")}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Canal")}
              <select
                aria-label={t("Canal da recuperação")}
                className="mt-1 block w-full rounded-md border bg-background p-2"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                <option value="">{t("Escolha um canal")}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              {t("Provedor")}
              <Input
                value={provider}
                placeholder="anthropic"
                onChange={(e) => setProvider(e.target.value)}
              />
            </label>
            <label className="text-sm">
              {t("Modelo")}
              <Input value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
            <label className="text-sm">
              {t("Credencial")}
              <select
                aria-label={t("Credencial da recuperação")}
                className="mt-1 block w-full rounded-md border bg-background p-2"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
              >
                <option value="">{t("Chave da instalação (se configurada)")}</option>
                {credentials
                  .filter((c) => c.provider === provider)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <Button
            type="button"
            disabled={readOnly || busy || !channel || !provider || !model}
            onClick={recover}
          >
            {t(busy ? "Conferindo configuração…" : "Conferir e publicar configuração preservada")}
          </Button>
        </>
      )}
    </section>
  );
}
