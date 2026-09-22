"use client";
import { useState, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CanalVozClient } from "@/components/connections/CanalVozClient";
import { PainelDeChamadaDeVoz } from "@/components/voice/PainelDeChamadaDeVoz";
import { randomId } from "@/lib/random-id";
import { Phone } from "@/lib/ui/icons";
import { activeStatuses, statusLabels, type MissionInput } from "@/lib/voice/missions/schema";

type Choice = {
  id: string;
  name: string;
  phone_number?: string | null;
  status?: string;
  ready?: boolean;
};
type Mission = Omit<MissionInput, "action"> & {
  status: string;
  error: string | null;
  cancel_requested: boolean;
  result: {
    summary?: string;
    transcript?: { role: string; text: string }[];
    next_step?: string;
  } | null;
};
type Panel = {
  voice: { configured: boolean; enabled: boolean };
  defaults: { agent_id: string | null; channel_id: string | null };
  contact: { name: string; phone: string };
  missions: Mission[];
  agents: Choice[];
  channels: Choice[];
  contacts: Choice[];
};
const selectClass =
  "w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

export function VoiceMissionDialog({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Phone size={15} aria-hidden />
          Pedir ligação à IA
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1rem)] max-w-xl overflow-y-auto rounded-2xl">
        <DialogTitle>O que essa ligação precisa resolver?</DialogTitle>
        <DialogDescription>
          A IA usa o contexto deste atendimento. Seu pedido fica só com a equipe.
        </DialogDescription>
        {open && <MissionEditor key={conversationId} conversationId={conversationId} />}
      </DialogContent>
    </Dialog>
  );
}

function MissionEditor({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const key = ["voice-missions", conversationId];
  const url = `/api/v1/conversations/${conversationId}/voice-missions`;
  const q = useQuery({
    queryKey: key,
    queryFn: () => apiClient.get<{ data: Panel }>(url),
    refetchInterval: 5000,
  });
  const [draft, setDraft] = useState<MissionInput>(() => ({
    id: randomId(),
    action: "save",
    objective: "",
    agent_id: null,
    channel_id: null,
    test_contact_id: null,
    test: false,
  }));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const sending = useRef(false);
  const [choicesOpen, setChoicesOpen] = useState(false);
  const data = q.data?.data;
  if (data && !loaded) {
    const previous = data.missions.find((m) => m.status === "draft");
    if (previous)
      setDraft({
        id: previous.id,
        action: "save",
        objective: previous.objective,
        agent_id: previous.agent_id,
        channel_id: previous.channel_id,
        test_contact_id: previous.test_contact_id,
        test: previous.test && !!previous.test_contact_id,
      });
    setLoaded(true);
  }
  function update(p: Partial<MissionInput>) {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
    setError("");
  }
  const effective = {
    ...draft,
    agent_id: draft.agent_id ?? data?.defaults.agent_id ?? null,
    channel_id: draft.channel_id ?? data?.defaults.channel_id ?? null,
  };
  async function send(action: MissionInput["action"], id = draft.id) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await apiClient.post(url, { ...effective, id, action });
      setSaved(action === "save");
      await qc.invalidateQueries({ queryKey: key });
      if (action === "start") setDraft((d) => ({ ...d, id: randomId(), objective: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível concluir. Tente novamente.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  if (q.isLoading) return <p role="status">Carregando o atendimento…</p>;
  if (q.isError || !data)
    return (
      <div role="alert">
        <p>Não foi possível carregar a ligação.</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  const active = data.missions.find((m) => activeStatuses.includes(m.status));
  const selectedChannel = data.channels.find((c) => c.id === effective.channel_id);
  const connected = data.channels.some((c) => c.ready);
  const needsConnection = !data.voice.configured || !data.voice.enabled || !connected;
  const recipient = draft.test
    ? data.contacts.find((c) => c.id === draft.test_contact_id)
    : { name: data.contact.name, phone_number: data.contact.phone };
  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-muted/50 p-3 text-sm">
        <strong>{data.contact.name || "Cliente deste atendimento"}</strong>
        <p className="mt-1 text-muted-foreground">
          A IA se apresenta, escuta com calma e adapta a conversa ao seu objetivo, usando o
          histórico deste atendimento.
        </p>
      </div>
      {active ? (
        <section aria-label="Ligação em andamento" className="space-y-3 rounded-xl border p-4">
          <p role="status" aria-live="polite" className="font-medium">
            {statusLabels[active.status]}
          </p>
          <p className="text-sm">{active.objective}</p>
          <p className="text-xs text-muted-foreground">
            Você pode fechar este painel. A ligação continua no servidor.
          </p>
          <Button
            variant="destructive"
            disabled={busy || active.cancel_requested}
            onClick={() => send("cancel", active.id)}
          >
            {active.cancel_requested ? "Encerramento solicitado" : "Encerrar ligação"}
          </Button>
        </section>
      ) : (
        <>
          <div className="block space-y-2 text-sm font-medium">
            <label htmlFor="voice-objective">Seu objetivo</label>
            <textarea
              id="voice-objective"
              className={`${selectClass} min-h-24 font-normal`}
              maxLength={3000}
              value={draft.objective}
              onChange={(e) => update({ objective: e.target.value })}
              placeholder="Ligue para entender a objeção à proposta e combinar um próximo passo."
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {draft.test ? "Teste com " : "Ligação para "}
            <strong className="text-foreground">{recipient?.name || "contato a escolher"}</strong>
            {recipient?.phone_number && ` · ${recipient.phone_number}`}
            <span className="mt-1 block">
              Até 5 minutos. Usa o saldo de IA da empresa. Salvar não inicia a chamada.
            </span>
          </p>
          {needsConnection && (
            <section className="space-y-3 rounded-xl border p-3" aria-label="Conectar chamadas">
              <p className="text-sm">
                {data.voice.enabled
                  ? "Seu WhatsApp de mensagens não conecta as chamadas automaticamente. Conecte o número uma vez pelo QR Code."
                  : "Ative as chamadas da empresa e conecte o número uma vez pelo QR Code."}
              </p>
              {setupOpen ? (
                <>
                  {!data.voice.enabled && <PainelDeChamadaDeVoz />}
                  {data.voice.enabled && (
                    <CanalVozClient wacallsConfigured={data.voice.configured} />
                  )}
                </>
              ) : (
                <Button onClick={() => setSetupOpen(true)}>Conectar número para ligar</Button>
              )}
            </section>
          )}
          <details
            className="rounded-xl border p-3"
            open={choicesOpen}
            onToggle={(event) => setChoicesOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer text-sm font-medium">
              Ajustes da ligação
              <span className="block font-normal text-muted-foreground">
                {data.agents.find((a) => a.id === effective.agent_id)?.name || "Agente a escolher"}
                {" · "}
                {selectedChannel?.name ||
                  selectedChannel?.phone_number ||
                  (selectedChannel ? "Número de chamadas" : "Número a escolher")}
                {draft.test ? " · modo de teste" : ""}
              </span>
            </summary>
            <div className="mt-4 space-y-4">
              <label className="block space-y-1 text-sm">
                Agente
                <select
                  id="voice-agent"
                  className={selectClass}
                  value={effective.agent_id ?? ""}
                  onChange={(e) => update({ agent_id: e.target.value || null })}
                >
                  <option value="">Escolher depois</option>
                  {data.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.ready ? "" : " · publique e ative para ligar"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                Número que fará a ligação
                <select
                  className={selectClass}
                  id="voice-channel"
                  value={effective.channel_id ?? ""}
                  onChange={(e) => update({ channel_id: e.target.value || null })}
                >
                  <option value="">Escolher depois</option>
                  {data.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.phone_number || "WhatsApp"}
                      {c.status === "WORKING" ? "" : " · desconectado"}
                    </option>
                  ))}
                </select>
              </label>
              {!data.channels.length && (
                <p className="text-sm text-muted-foreground">
                  Você pode salvar agora e{" "}
                  <Link className="underline" href="/app/connections?aba=voz">
                    conectar um número em Conexões
                  </Link>{" "}
                  depois.
                </p>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={draft.test}
                  onChange={(e) => update({ test: e.target.checked })}
                />
                <span>
                  Fazer um teste primeiro
                  <span className="block text-xs text-muted-foreground">
                    Usa o contexto deste atendimento, mas liga para o contato de teste escolhido.
                  </span>
                </span>
              </label>
              {draft.test ? (
                <label className="block space-y-1 text-sm">
                  Contato autorizado para o teste
                  <select
                    className={selectClass}
                    id="voice-test-contact"
                    value={draft.test_contact_id ?? ""}
                    onChange={(e) => update({ test_contact_id: e.target.value || null })}
                  >
                    <option value="">Escolher depois</option>
                    {data.contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.phone_number} · {c.phone_number}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    Escolha alguém autorizado a receber a ligação e conhecer o contexto deste
                    atendimento.
                  </span>
                </label>
              ) : (
                <p className="text-sm">
                  A ligação será para <strong>{data.contact.name}</strong> · {data.contact.phone}.
                </p>
              )}
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            {!needsConnection && (
              <Button
                disabled={busy}
                onClick={() => {
                  if (draft.objective.trim().length < 8) {
                    setError("Conte o que a IA precisa resolver nesta ligação.");
                    document.getElementById("voice-objective")?.focus();
                    return;
                  }
                  if (
                    !effective.agent_id ||
                    !effective.channel_id ||
                    (draft.test && !draft.test_contact_id)
                  ) {
                    setChoicesOpen(true);
                    const field = !effective.agent_id
                      ? "voice-agent"
                      : !effective.channel_id
                        ? "voice-channel"
                        : "voice-test-contact";
                    requestAnimationFrame(() => document.getElementById(field)?.focus());
                    setError(
                      "Escolha nos ajustes o agente ou número disponível para esta ligação.",
                    );
                    return;
                  }
                  void send("start");
                }}
              >
                {busy ? "Iniciando…" : draft.test ? "Ligar para contato de teste" : "Ligar agora"}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => send("save")}>
              {busy ? "Aguarde…" : "Salvar para depois"}
            </Button>
          </div>
          {saved && (
            <p role="status" className="text-sm">
              Pedido salvo. Nenhuma ligação foi iniciada.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {data.missions
        .filter((m) => !activeStatuses.includes(m.status) && m.status !== "draft")
        .map((m) => (
          <section key={m.id} className="space-y-2 rounded-xl border p-3">
            <strong className="text-sm">{statusLabels[m.status]}</strong>
            <p className="text-sm">{m.objective}</p>
            {m.error && <p className="text-sm text-destructive">{m.error}</p>}
            {m.result?.summary && <p className="text-sm">{m.result.summary}</p>}
            {m.result?.next_step && (
              <p className="text-sm">
                <strong>Próximo passo: </strong>
                {m.result.next_step}
              </p>
            )}
            {!!m.result?.transcript?.length && (
              <details>
                <summary className="cursor-pointer text-sm">Ver conversa da ligação</summary>
                <div className="mt-2 space-y-2 text-sm">
                  {m.result.transcript.map((line, i) => (
                    <p key={i}>
                      <strong>{line.role === "agent" ? "IA" : "Contato"}: </strong>
                      {line.text}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </section>
        ))}
    </div>
  );
}
