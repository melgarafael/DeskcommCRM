"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { configEntregaSchema, type ConfigEntrega } from "@/lib/schemas/handoff-delivery";
import type { ChannelRoutingSettings } from "@/lib/routing/channel-policies";
export function HandoffDeliveryForm({
  initial,
  members,
}: {
  initial: ConfigEntrega;
  members: ChannelRoutingSettings["members"];
}) {
  const [issues, setIssues] = useState<
    Array<{ conversation_id: string; status: string; reason: string | null }>
  >([]);
  const t = useT();
  const [config, setConfig] = useState(() => {
    const activeIds = new Set(members.map((member) => member.id));
    const sellerIds = initial.seller_user_ids.filter((id) => activeIds.has(id));
    return {
      ...initial,
      seller_user_ids: sellerIds,
      seller_destinations: Object.fromEntries(
        Object.entries(initial.seller_destinations).filter(([id]) => sellerIds.includes(id)),
      ),
    };
  });
  const [supervisors, setSupervisors] = useState(initial.supervisor_destinations.join("\n"));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  async function check() {
    setBusy(true);
    setFeedback("");
    try {
      const r = await fetch("/api/v1/settings/handoff-delivery");
      const data = await r.json();
      if (!r.ok) {
        setFeedback(t("Não foi possível consultar as passagens."));
        return;
      }
      setIssues(data.data.issues);
      setFeedback(t("Passagens consultadas. Nenhuma mensagem foi enviada."));
    } catch {
      setFeedback(t("Não foi possível consultar as passagens."));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const parsed = configEntregaSchema.safeParse({
      ...config,
      supervisor_destinations: supervisors
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      setFeedback(t("Confira vendedores e números com DDI, por exemplo +55, antes de ativar."));
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch("/api/v1/settings/handoff-delivery", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json();
      if (!response.ok) {
        setFeedback(t(body.error?.message ?? "Não foi possível salvar."));
        return;
      }
      setConfig(body.data);
      setFeedback(t("Configuração salva. Não foi enviada mensagem de teste."));
    } catch {
      setFeedback(t("Não foi possível salvar. Tente novamente."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby="handoff-delivery-title">
      <h2 id="handoff-delivery-title" className="text-lg font-semibold">
        {t("Passagem da IA para a equipe")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Após a IA passar o atendimento, distribui em rodízio entre vendedores disponíveis, mantém o mesmo responsável no Inbox e no card e permite enviar um resumo pelo WhatsApp. A IA fica pausada. Não encerra a venda nem troca o número da conversa.",
        )}
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
          />
          {t("Ativar passagem humana nesta empresa")}
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={config.notifications_enabled !== false}
            onChange={(e) => setConfig((c) => ({ ...c, notifications_enabled: e.target.checked }))}
          />
          {t("Enviar avisos pelo WhatsApp após atribuir")}
        </label>
        <p className="text-sm text-muted-foreground">
          {t(
            "Com avisos desligados, atribui o atendimento no CRM sem enviar mensagem ao vendedor ou supervisor. A IA continua pausada após o repasse.",
          )}
        </p>
        {members.map((m) => (
          <div key={m.id} className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.seller_user_ids.includes(m.id)}
                onChange={(e) =>
                  setConfig((c) => {
                    const ids = e.target.checked
                      ? [...c.seller_user_ids, m.id]
                      : c.seller_user_ids.filter((id) => id !== m.id);
                    return {
                      ...c,
                      seller_user_ids: ids,
                      seller_destinations: Object.fromEntries(
                        Object.entries(c.seller_destinations).filter(([id]) => ids.includes(id)),
                      ),
                    };
                  })
                }
              />
              {m.name}
            </label>
            {config.notifications_enabled !== false && config.seller_user_ids.includes(m.id) && (
              <Input
                aria-label={t("WhatsApp de") + " " + m.name}
                placeholder="+55…"
                inputMode="tel"
                value={config.seller_destinations[m.id] ?? ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    seller_destinations: { ...c.seller_destinations, [m.id]: e.target.value },
                  }))
                }
              />
            )}
          </div>
        ))}
        {!members.length && <p>{t("Cadastre os vendedores na equipe antes de ativar.")}</p>}
        <label className="block space-y-1">
          <span>{t("WhatsApp dos supervisores — um número com DDI por linha")}</span>
          <textarea
            className="w-full rounded-md border bg-background p-2"
            rows={3}
            disabled={config.notifications_enabled === false}
            value={supervisors}
            onChange={(e) => setSupervisors(e.target.value)}
            placeholder="+55…"
          />
        </label>
        <label className="block space-y-1">
          <span>{t("Links no aviso ao vendedor")}</span>
          <select
            aria-label={t("Links no aviso ao vendedor")}
            className="w-full rounded-md border bg-background p-2"
            value={config.notice_links}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "crm" || value === "whatsapp" || value === "both")
                setConfig((c) => ({ ...c, notice_links: value }));
            }}
          >
            <option value="crm">{t("Abrir atendimento no CRM")}</option>
            <option value="whatsapp">{t("Chamar cliente no WhatsApp")}</option>
            <option value="both">{t("CRM e WhatsApp do cliente")}</option>
          </select>
          <p className="text-sm text-muted-foreground">
            {t("Sem telefone válido do cliente, o aviso mantém o link do CRM.")}
          </p>
        </label>
        <p className="text-sm text-muted-foreground">
          {t(
            "Somente avisos individuais. Não conecta o WhatsApp pessoal como canal. Os limites de envio do número continuam valendo. Resultados incertos exigem revisão; não são reenviados automaticamente.",
          )}
        </p>
        <Button variant="outline" onClick={() => void check()}>
          {t("Conferir passagens pendentes")}
        </Button>
        <Button onClick={() => void save()}>{t(busy ? "Salvando…" : "Salvar passagem")}</Button>
      </fieldset>
      {issues.map((item) => (
        <p key={item.conversation_id} className="text-sm">
          <a
            className="underline"
            href={`/app/inbox?id=${encodeURIComponent(item.conversation_id)}`}
          >
            {t("Conferir atendimento")}
          </a>{" "}
          —{" "}
          {t(
            item.status === "ambiguous"
              ? "Envio incerto: revisar antes de repetir"
              : item.status === "blocked"
                ? "Passagem bloqueada: conferir configuração, card e responsáveis"
                : "Aguardando entrega",
          )}
        </p>
      ))}
      <p role="status" aria-live="polite" className="text-sm">
        {feedback}
      </p>
    </section>
  );
}
