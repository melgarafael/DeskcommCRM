"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoCanal } from "@/lib/channels/estado";
import type { ChannelRoutingSettings } from "@/lib/routing/channel-policies";

export function ChannelRoutingForm({ initial }: { initial: ChannelRoutingSettings }) {
  const t = useT(); const router = useRouter();
  const [channels, setChannels] = useState(initial.channels);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  async function save(id: string, reset: boolean) {
    setBusy(id); setFeedback("");
    try {
      const response = await fetch("/api/v1/settings/routing/channels", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_session_id: id, user_ids: channels.find((c) => c.id === id)?.user_ids ?? [], reset }) });
      const result = await response.json();
      if (!response.ok) { setFeedback(t(result.error?.message ?? "Não foi possível salvar. Tente novamente.")); return; }
      setChannels((current) => current.map((c) => c.id === id ? { ...c, mode: result.data.mode, user_ids: result.data.user_ids } : c));
      setFeedback(t("Responsáveis salvos.")); router.refresh();
    } catch { setFeedback(t("Não foi possível salvar. Tente novamente.")); } finally { setBusy(null); }
  }
  return <section className="space-y-4" aria-labelledby="channel-routing-title">
    <h2 id="channel-routing-title" className="text-lg font-semibold">{t("Responsáveis por número")}</h2>
    <p className="text-sm text-muted-foreground">{t("A capacidade e o horário de cada pessoa valem para todos os números. A distribuição automática respeita os responsáveis de cada canal.")}</p>
    {!channels.length && <Link className="underline" href="/app/connections">{t("Conecte um número para escolher os responsáveis.")}</Link>}
    {channels.map((channel) => <fieldset key={channel.id} className="rounded-lg border p-4 space-y-3" disabled={busy !== null}>
      <legend className="px-2 font-medium">{t(nomeDoCanal(channel))}</legend>
      <p className="text-sm" data-testid="channel-routing-state">{t(channel.mode === "legacy_unconfigured" ? "Usa todos os atendentes elegíveis da organização." : channel.mode === "restricted_empty" ? "Ninguém configurado — as conversas ficarão na fila." : "Somente as pessoas selecionadas recebem este número.")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {initial.members.map((member) => <label key={member.id} className="flex items-center gap-2 rounded-md p-2 hover:bg-muted">
          <input type="checkbox" checked={channel.user_ids.includes(member.id)} onChange={(e) => setChannels((current) => current.map((c) => c.id === channel.id ? { ...c, user_ids: e.target.checked ? [...c.user_ids, member.id] : c.user_ids.filter((id) => id !== member.id) } : c))} />
          <span>{t(member.name)}</span>
        </label>)}
      </div>
      {!initial.members.length && <p className="text-sm text-muted-foreground">{t("Nenhum atendente ativo na equipe.")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save(channel.id, false)}>{t(busy === channel.id ? "Salvando…" : "Salvar responsáveis")}</Button>
        <Button variant="outline" onClick={() => void save(channel.id, true)}>{t("Voltar ao padrão da organização")}</Button>
      </div>
    </fieldset>)}
    <p role="status" aria-live="polite" className="text-sm">{feedback}</p>
  </section>;
}
