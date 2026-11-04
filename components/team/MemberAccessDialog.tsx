"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
type Scope = {
  pipeline_ids: string[] | null;
  channel_ids: string[] | null;
  restrict_contacts: boolean;
};
type Data = {
  privacy_enabled?: boolean;
  scope: Scope | null;
  pipelines: { id: string; name: string }[];
  channels: { id: string; display_name: string | null; phone_number: string | null }[];
};
export function MemberAccessDialog({
  member,
  onClose,
}: {
  member: { id: string; name: string };
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [data, setData] = useState<Data | null>(null);
  const [scope, setScope] = useState<Scope>({
    pipeline_ids: [],
    channel_ids: [],
    restrict_contacts: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiClient
      .get<{ data: Data }>(`/api/v1/team/access-scopes?user_id=${member.id}`)
      .then((r) => {
        if (active) {
          setData(r.data);
          setScope(r.data.scope ?? { pipeline_ids: [], channel_ids: [], restrict_contacts: true });
        }
      })
      .catch(() => {
        if (active) setError(t("Não foi possível carregar os acessos."));
      });
    return () => {
      active = false;
    };
  }, [member.id, t]);
  async function save(reset = false) {
    setBusy(true);
    setError("");
    try {
      await apiClient.patch("/api/v1/team/access-scopes", { user_id: member.id, ...scope, reset });
      await qc.invalidateQueries();
      onClose();
    } catch {
      setError(t("Não foi possível salvar os acessos."));
    } finally {
      setBusy(false);
    }
  }
  function toggle(key: "pipeline_ids" | "channel_ids", id: string, checked: boolean) {
    setScope((s) => ({
      ...s,
      [key]: checked ? [...(s[key] ?? []), id] : (s[key] ?? []).filter((v) => v !== id),
    }));
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("Acessos do atendente")}: {member.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Escolha os funis e números permitidos. A visibilidade por responsável continua valendo. Responsáveis do rodízio são configurados separadamente.",
            )}
          </DialogDescription>
        </DialogHeader>
        {data?.privacy_enabled === false && (
          <p role="alert">
            {t(
              "Configure primeiro a privacidade do cadastro em Equipe → Privacidade e responsabilidade comercial.",
            )}
          </p>
        )}
        {data && (
          <div className="space-y-4">
            {!data.scope && (
              <p>
                {t(
                  "Este atendente usa os acessos atuais da empresa. Salvar ativa as restrições selecionadas.",
                )}
              </p>
            )}
            {(["pipeline_ids", "channel_ids"] as const).map((key) => (
              <fieldset key={key} disabled={busy} className="space-y-2">
                <legend>
                  {t(key === "pipeline_ids" ? "Funis permitidos" : "Números permitidos")}
                </legend>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={scope[key] === null}
                    onChange={(e) =>
                      setScope((s) => ({ ...s, [key]: e.target.checked ? null : [] }))
                    }
                  />
                  {t("Todos")}
                </label>
                {scope[key] !== null &&
                  (key === "pipeline_ids"
                    ? data.pipelines.map((p) => ({ id: p.id, label: p.name }))
                    : data.channels.map((c) => ({
                        id: c.id,
                        label: c.display_name ?? c.phone_number ?? c.id,
                      }))
                  ).map((item) => (
                    <label className="flex gap-2" key={item.id}>
                      <input
                        type="checkbox"
                        checked={scope[key]?.includes(item.id) ?? false}
                        onChange={(e) => toggle(key, item.id, e.target.checked)}
                      />
                      {item.label}
                    </label>
                  ))}
                {scope[key]?.length === 0 && (
                  <p className="text-sm">{t("Nenhum acesso neste grupo.")}</p>
                )}
              </fieldset>
            ))}
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={scope.restrict_contacts}
                disabled={busy}
                onChange={(e) => setScope((s) => ({ ...s, restrict_contacts: e.target.checked }))}
              />
              {t("Contatos somente por atendimentos e negócios permitidos")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t(
                "Memórias globais e pedidos sem vínculo de negociação ficam ocultos para este perfil. Notas internas permanecem na conversa autorizada.",
              )}
            </p>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Cancelar")}
          </Button>
          {data?.scope && (
            <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
              {t("Restaurar acessos da empresa")}
            </Button>
          )}
          <Button disabled={!data || busy|| data.privacy_enabled === false} onClick={() => void save()}>
            {t("Salvar acessos")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
