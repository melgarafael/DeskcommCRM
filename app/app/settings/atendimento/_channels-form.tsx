"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoCanal } from "@/lib/channels/estado";
import { ESPERA_PELA_IA_MAX_MINUTOS, ESPERA_PELA_IA_MIN_MINUTOS, ROUTING_MODES, type RoutingMode } from "@/lib/schemas/routing";
import type { ChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { MODO_COPY } from "./_form";

export function ChannelRoutingForm({ initial }: { initial: ChannelRoutingSettings }) {
  const t = useT(); const router = useRouter();
  const [channels, setChannels] = useState(initial.channels);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  async function save(id: string, reset: boolean) {
    setBusy(id); setFeedback("");
    try {
      const alvo = channels.find((c) => c.id === id);
      const response = await fetch("/api/v1/settings/routing/channels", { method: "PATCH", headers: { "Content-Type": "application/json" },
        // A regra POR NÚMERO (#2331) vai no mesmo corpo dos responsáveis: é uma
        // tela e um botão. `null` = este número não tem regra própria e cai no
        // comportamento da organização.
        body: JSON.stringify({ channel_session_id: id, user_ids: alvo?.user_ids ?? [], reset,
          distribution_mode: alvo?.distribution_mode ?? null,
          default_assignee_user_id: alvo?.default_assignee_user_id ?? null,
          // #3966: `undefined` some do JSON e a rota preserva o que valia.
          ai_wait_minutes: alvo?.ai_wait_minutes }) });
      const result = await response.json();
      if (!response.ok) { setFeedback(t(result.error?.message ?? "Não foi possível salvar. Tente novamente.")); return; }
      setChannels((current) => current.map((c) => c.id === id ? { ...c, mode: result.data.mode, user_ids: result.data.user_ids,
        distribution_mode: result.data.distribution_mode ?? null,
        default_assignee_user_id: result.data.default_assignee_user_id ?? null,
        ai_wait_minutes: result.data.ai_wait_minutes === undefined ? c.ai_wait_minutes : result.data.ai_wait_minutes } : c));
      setFeedback(t("Responsáveis salvos.")); router.refresh();
    } catch { setFeedback(t("Não foi possível salvar. Tente novamente.")); } finally { setBusy(null); }
  }
  const trocarModo = (id: string, valor: string) => setChannels((current) => current.map((c) => c.id === id
    ? { ...c, distribution_mode: (valor === "" ? null : valor) as RoutingMode | null,
        // Sem modo próprio não há distribuição por modo: o destino padrão perde o
        // sentido (na organização o número volta a ser exatamente o de antes).
        default_assignee_user_id: valor === "" ? null : c.default_assignee_user_id } : c));
  // Vazio = opção desligada (o padrão). Um campo só: não existe esperar sem prazo.
  const trocarEspera = (id: string, valor: string) => setChannels((current) => current.map((c) => c.id === id
    ? { ...c, ai_wait_minutes: valor.trim() === "" || !Number.isFinite(Number(valor)) ? null : Math.trunc(Number(valor)) } : c));
  const trocarDestino = (id: string, valor: string) => setChannels((current) => current.map((c) => c.id === id
    ? { ...c, default_assignee_user_id: valor === "" ? null : valor } : c));
  return <section className="space-y-4" aria-labelledby="channel-routing-title">
    <h2 id="channel-routing-title" className="text-lg font-semibold">{t("Responsáveis por número")}</h2>
    <p className="text-sm text-muted-foreground">{t("A capacidade e o horário de cada pessoa valem para todos os números. A distribuição automática respeita os responsáveis de cada canal.")}</p>
    {!channels.length && <Link className="underline" href="/app/connections">{t("Conecte um número para escolher os responsáveis.")}</Link>}
    {channels.map((channel) => <fieldset key={channel.id} className="rounded-lg border p-4 space-y-3" disabled={busy !== null}>
      <legend className="px-2 font-medium">{t(nomeDoCanal(channel))}</legend>
      <p className="text-sm" data-testid="channel-routing-state">{t(channel.mode === "legacy_unconfigured" ? "Usa todos os atendentes elegíveis da organização." : channel.mode === "restricted_empty" ? "Ninguém configurado — as conversas ficarão na fila." : "Somente as pessoas selecionadas recebem este número.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor={`modo-${channel.id}`}>{t("Como este número distribui")}</label>
          <select id={`modo-${channel.id}`} data-testid={`modo-do-numero-${channel.id}`} className="w-full rounded-md border bg-background p-2 text-sm"
            value={channel.distribution_mode ?? ""} onChange={(e) => trocarModo(channel.id, e.target.value)}>
            <option value="">{t("Usar o padrão da organização")}</option>
            {ROUTING_MODES.map((m) => <option key={m} value={m}>{t(MODO_COPY[m].titulo)}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">{t("Vale só para este número. Os números sem regra própria continuam com o que está definido para a organização.")}</p>
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor={`destino-${channel.id}`}>{t("Atendente de destino padrão")}</label>
          <select id={`destino-${channel.id}`} data-testid={`destino-do-numero-${channel.id}`} className="w-full rounded-md border bg-background p-2 text-sm"
            value={channel.default_assignee_user_id ?? ""} onChange={(e) => trocarDestino(channel.id, e.target.value)} disabled={!channel.distribution_mode}>
            <option value="">{t("Nenhum — distribuir pelo modo")}</option>
            {initial.members.map((member) => <option key={member.id} value={member.id}>{t(member.name)}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">{t("Escolhendo uma pessoa, todo cliente novo deste número vai direto para ela, sem passar pela distribuição. Precisa estar disponível para receber.")}</p>
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor={`espera-ia-${channel.id}`}>{t("Esperar a IA qualificar antes de distribuir (minutos)")}</label>
        <input id={`espera-ia-${channel.id}`} data-testid={`espera-pela-ia-${channel.id}`} type="number" inputMode="numeric"
          min={ESPERA_PELA_IA_MIN_MINUTOS} max={ESPERA_PELA_IA_MAX_MINUTOS} step={1} placeholder={t("Desligado")}
          className="w-full rounded-md border bg-background p-2 text-sm sm:w-48"
          value={channel.ai_wait_minutes ?? ""} onChange={(e) => trocarEspera(channel.id, e.target.value)} />
        <p className="text-xs text-muted-foreground">{t("Vazio, vale a regra de sempre: a conversa nova é distribuída na hora. Com um prazo, entre 15 minutos e 7 dias, a conversa deste número fica com a IA até ela passar para uma pessoa. Se o prazo vencer sem a IA passar, a conversa entra na distribuição e a Central avisa. Só vale no rodízio ou na menor carga, e não vale quando o número tem atendente de destino padrão.")}</p>
      </div>
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
