"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { EscolhaDoCliente } from "@/components/agenda/EscolhaDoCliente";
import { useT } from "@/hooks/i18n/useT";
type Vinculos = {
  contacts: Array<{ id: string; name: string; email?: string | null }>;
  conversations: Array<{ id: string; created_at: string; status: string }>;
};
export function VinculoDaMarcacao({
  contactId,
  conversationId,
  onChange,
}: {
  contactId: string;
  conversationId: string;
  /** O terceiro argumento e o e-mail do contato escolhido, quando ele tem um. */
  onChange: (contact: string, conversation: string, email?: string | null) => void;
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
      {/* Um campo só. Eram dois — "Buscar cliente" e "Quem será atendido" —, e
          quem opera relatou pela tela que o segundo parecia que ia abrir algo ao
          digitar e o primeiro parecia não fazer nada. */}
      <EscolhaDoCliente
        contatos={query.data?.contacts ?? []}
        valor={contactId}
        busca={search}
        onBusca={(q) => {
          setSearch(q);
          // Digitar solta a escolha anterior. Sem isto a lista filtraria por um
          // nome enquanto o contato preso continuaria sendo outro — e o
          // compromisso sairia no nome de quem ninguém escolheu.
          onChange("", "", null);
        }}
        onEscolhe={(id) =>
          onChange(id, "", query.data?.contacts.find((c) => c.id === id)?.email ?? null)
        }
      />
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
