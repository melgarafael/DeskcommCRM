"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
type Rule = { channel_id: string; pipeline_id: string; member_ids: string[] };
type Data = {
  privacy: { basic_field_keys: string[]; basic_tags: string[] } | null;
  rules: Rule[];
  channels: { id: string; display_name: string | null; phone_number: string | null }[];
  pipelines: { id: string; name: string }[];
  pending: { conversation_id: string; status: string }[];
  sources: { id: string; name: string; default_pipeline_id: string }[];
  source_bindings: { source_id: string; rule_channel_id: string }[];
  source_pending: { lead_id: string; source_id: string; status: string }[];
};
type Member = { user_id: string; role: string; full_name: string | null; email: string | null };
const split = (s: string) => [
  ...new Set(
    s
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
export function OperationalBoundariesDialog({
  members,
  onClose,
}: {
  members: Member[];
  onClose: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState(""),
    [tags, setTags] = useState(""),
    [ack, setAck] = useState(false);
  const [channel, setChannel] = useState(""),
    [pipeline, setPipeline] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState(""),
    [sourceChannel, setSourceChannel] = useState("");
  async function load() {
    const r = await apiClient.get<{ data: Data }>("/api/v1/team/operational-boundaries");
    setData(r.data);
    setKeys((r.data.privacy?.basic_field_keys ?? []).join(", "));
    setTags((r.data.privacy?.basic_tags ?? []).join(", "));
  }
  useEffect(() => {
    let active = true;
    apiClient
      .get<{ data: Data }>("/api/v1/team/operational-boundaries")
      .then((r) => {
        if (active) {
          setData(r.data);
          setKeys((r.data.privacy?.basic_field_keys ?? []).join(", "));
          setTags((r.data.privacy?.basic_tags ?? []).join(", "));
        }
      })
      .catch(() => {
        if (active) setError(t("Não foi possível carregar a configuração."));
      });
    return () => {
      active = false;
    };
  }, [t]);
  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await apiClient.post("/api/v1/team/operational-boundaries", body);
      await load();
      setAck(false);
    } catch {
      setError(t("Não foi possível salvar. Confira a configuração e os acessos."));
    } finally {
      setBusy(false);
    }
  }
  function chooseChannel(id: string) {
    setChannel(id);
    const r = data?.rules.find((x) => x.channel_id === id);
    setPipeline(r?.pipeline_id ?? "");
    setSelected(r?.member_ids ?? []);
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Privacidade e responsabilidade comercial")}</DialogTitle>
          <DialogDescription>
            {t(
              "Configuração desta empresa. A condução da conversa pela IA continua independente do responsável comercial.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert">{error}</p>}
        {data && (
          <div className="space-y-6">
            <fieldset disabled={busy} className="space-y-3">
              <legend className="font-semibold">{t("Cadastro compartilhado")}</legend>
              <p className="text-sm">
                {t(
                  "Somente os campos e marcadores declarados abaixo ficam no cadastro compartilhado. Os demais valores, a origem e seus detalhes ficam preservados no histórico reservado, acessível à gestão na ficha. Respostas novas de roteiro pertencem à conversa.",
                )}
              </p>
              <label className="block">
                {t("Chaves dos campos cadastrais compartilhados, separadas por vírgula")}
                <input
                  className="mt-1 w-full rounded border p-2"
                  value={keys}
                  onChange={(e) => setKeys(e.target.value)}
                />
              </label>
              <label className="block">
                {t("Marcadores cadastrais compartilhados, separados por vírgula")}
                <input
                  className="mt-1 w-full rounded border p-2"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Vazio mantém todos os campos extras e marcadores reservados. Não escolha campos de negociação. Esta ação não altera consentimentos, bloqueios ou a conexão do WhatsApp. Escritas simultâneas nesta empresa podem precisar de nova tentativa durante a reserva.",
                )}
              </p>
              <label className="flex gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t("Confirmo a reserva dos dados atuais desta empresa, preservando o histórico.")}
              </label>
              <Button
                disabled={!ack}
                onClick={() =>
                  void save({
                    action: "privacy",
                    basic_field_keys: split(keys),
                    basic_tags: split(tags),
                    ack_archive: true,
                  })
                }
              >
                {data.privacy
                  ? t("Atualizar cadastro compartilhado")
                  : t("Ativar privacidade do cadastro")}
              </Button>
            </fieldset>
            <fieldset disabled={busy || !data.privacy} className="space-y-3">
              <legend className="font-semibold">{t("Responsável comercial na entrada")}</legend>
              {!data.privacy && <p>{t("Ative primeiro a privacidade do cadastro.")}</p>}
              <label className="block">
                {t("Número")}
                <select
                  className="mt-1 w-full rounded border p-2"
                  value={channel}
                  onChange={(e) => chooseChannel(e.target.value)}
                >
                  <option value="">{t("Selecione")}</option>
                  {data.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name ?? c.phone_number ?? t("Número sem nome")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                {t("Funil comercial")}
                <select
                  className="mt-1 w-full rounded border p-2"
                  value={pipeline}
                  onChange={(e) => setPipeline(e.target.value)}
                >
                  <option value="">{t("Selecione")}</option>
                  {data.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm">
                {t(
                  "Selecione os vendedores na ordem do rodízio. A carteira e os donos existentes são preservados. Remover alguém do rodízio afeta entradas novas; revogar acesso exige ajustar os acessos do atendente. Nenhum vendedor elegível deixa uma pendência para a gestão.",
                )}
              </p>
              {members
                .filter((m) => m.role === "agent")
                .map((m, i) => (
                  <label key={m.user_id} className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(m.user_id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, m.user_id] : s.filter((id) => id !== m.user_id),
                        )
                      }
                    />
                    {m.full_name ?? m.email ?? `${t("Atendente")} ${i + 1}`}
                    {selected.includes(m.user_id) ? ` (${selected.indexOf(m.user_id) + 1})` : ""}
                  </label>
                ))}
              <Button
                disabled={!channel || !pipeline}
                onClick={() =>
                  void save({
                    action: "commercial",
                    channel_id: channel,
                    pipeline_id: pipeline,
                    member_ids: selected,
                    disabled: false,
                  })
                }
              >
                {t("Salvar distribuição comercial")}
              </Button>
              {data.rules.some((r) => r.channel_id === channel) && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void save({
                      action: "commercial",
                      channel_id: channel,
                      pipeline_id: pipeline,
                      member_ids: selected,
                      disabled: true,
                    })
                  }
                >
                  {t("Desligar neste número")}
                </Button>
              )}
              <p className="text-sm">
                {t("Pendências de distribuição")}: {data.pending.length}
              </p>
              {data.pending.map((p) => (
                <p key={p.conversation_id}>
                  <a className="underline" href={`/app/inbox?id=${p.conversation_id}`}>
                    {t("Revisar atendimento pendente")}
                  </a>{" "}
                  —{" "}
                  {p.status === "pending_no_eligible"
                    ? t("Sem vendedor elegível")
                    : p.status === "pending_ambiguous"
                      ? t("Mais de um negócio aberto no funil")
                      : t("Dono existente sem acesso ao destino")}
                </p>
              ))}
            </fieldset>
            <fieldset disabled={busy || !data.privacy} className="space-y-3">
              <legend className="font-semibold">{t("Formulários sem conversa")}</legend>
              <p>
                {t(
                  "Vincule a fonte a uma distribuição comercial existente do mesmo funil. O número identifica a regra, não cria conversa, mensagem nem altera a IA. Sem vínculo, nada muda.",
                )}
              </p>
              <label className="block">
                {t("Fonte do formulário")}
                <select
                  className="mt-1 w-full rounded border p-2"
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setSourceChannel(
                      data.source_bindings.find((b) => b.source_id === e.target.value)
                        ?.rule_channel_id ?? "",
                    );
                  }}
                >
                  <option value="">{t("Selecione")}</option>
                  {data.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                {t("Regra comercial da fonte")}
                <select
                  className="mt-1 w-full rounded border p-2"
                  value={sourceChannel}
                  onChange={(e) => setSourceChannel(e.target.value)}
                >
                  <option value="">{t("Selecione")}</option>
                  {data.rules
                    .filter(
                      (r) =>
                        r.pipeline_id ===
                        data.sources.find((s) => s.id === source)?.default_pipeline_id,
                    )
                    .map((r) => (
                      <option key={r.channel_id} value={r.channel_id}>
                        {data.channels.find((c) => c.id === r.channel_id)?.display_name ??
                          t("Número sem nome")}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                disabled={!source || !sourceChannel}
                onClick={() =>
                  void save({
                    action: "commercial_source",
                    source_id: source,
                    channel_id: sourceChannel,
                    disabled: false,
                  })
                }
              >
                {t("Salvar vínculo da fonte")}
              </Button>
              {data.source_bindings.some((b) => b.source_id === source) && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void save({
                      action: "commercial_source",
                      source_id: source,
                      channel_id: sourceChannel,
                      disabled: true,
                    })
                  }
                >
                  {t("Desligar nesta fonte")}
                </Button>
              )}
              <p>
                {t("Formulários pendentes")}: {data.source_pending.length}
              </p>
              {data.source_pending.map((p) => (
                <div key={p.lead_id} className="space-y-2">
                  <p>
                    {data.sources.find((s) => s.id === p.source_id)?.name ??
                      t("Fonte indisponível")}{" "}
                    — {p.status}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void save({ action: "commercial_source_retry", lead_id: p.lead_id })
                    }
                  >
                    {t("Reavaliar distribuição deste negócio")}
                  </Button>
                </div>
              ))}
            </fieldset>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t("Fechar")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
