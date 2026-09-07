"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
type Vinculos = {
  contacts: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; created_at: string; status: string }>;
};
export function VinculoDaMarcacao({
  contactId,
  conversationId,
  onChange,
}: {
  contactId: string;
  conversationId: string;
  onChange: (contact: string, conversation: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["agenda", "vinculos", contactId, search],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams(contactId ? { contact_id: contactId } : { q: search })}`,
        )
      ).data,
  });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <label className="block">
        {t("Buscar cliente")}
        <input
          className="mt-1 w-full rounded-md border bg-surface p-2"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onChange("", "");
          }}
        />
      </label>
      <label className="block">
        {t("Quem será atendido")}
        <select
          className="mt-1 w-full rounded-md border bg-surface p-2"
          value={contactId}
          onChange={(e) => onChange(e.target.value, "")}
        >
          <option value="">{t("Compromisso pessoal, sem cliente")}</option>
          {query.data?.contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {contactId ? (
        <label className="block">
          {t("Conversa vinculada (opcional)")}
          <select
            className="mt-1 w-full rounded-md border bg-surface p-2"
            value={conversationId}
            onChange={(e) => onChange(contactId, e.target.value)}
          >
            <option value="">{t("Sem conversa vinculada")}</option>
            {query.data?.conversations.map((c, i) => (
              <option key={c.id} value={c.id}>
                {t("Conversa")} {i + 1} · {new Date(c.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {query.isError ? (
        <p role="alert">{t("Não foi possível carregar os vínculos. Tente novamente.")}</p>
      ) : null}
    </div>
  );
}
