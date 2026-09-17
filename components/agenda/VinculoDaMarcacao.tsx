"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
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
  const [criando, setCriando] = useState(false);
  const query = useQuery({
    queryKey: ["agenda", "vinculos", contactId, search],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams(contactId ? { contact_id: contactId } : { q: search })}`,
        )
      ).data,
  });

  // Quem marca horário costuma estar com a pessoa na frente, e ela nem sempre
  // já é contato. Sem esta saída o fluxo PARA aqui: teria que abandonar a
  // marcação, ir até Contatos, criar, voltar e recomeçar. O termo já digitado
  // vira o nome, e o contato volta selecionado.
  const buscou = search.trim().length > 0 && !contactId;
  const nadaEncontrado = buscou && !query.isLoading && (query.data?.contacts.length ?? 0) === 0;

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
      {nadaEncontrado ? (
        <button
          type="button"
          // Alvo de toque generoso: quem marca faz isso no celular, com o
          // cliente esperando na frente.
          className="min-h-11 w-full rounded-md border border-dashed px-3 text-left text-sm"
          onClick={() => setCriando(true)}
        >
          {t("Criar")} “{search.trim()}”
        </button>
      ) : null}
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
      {/* `key` pelo termo: `nomeInicial` é defaultValue do formulário e só vale
          na montagem. Sem remontar, quem fecha e digita outro nome reabriria com
          o anterior. */}
      <NewContactDialog
        key={search.trim()}
        open={criando}
        onOpenChange={setCriando}
        nomeInicial={search.trim()}
        onCriado={(contato) => {
          // Volta JÁ SELECIONADO. A busca passa a ser o nome do contato para a
          // lista conter quem acabou de nascer — senão o `select` ficaria com um
          // valor que ele não sabe desenhar.
          setSearch(contato.name ?? search);
          onChange(contato.id, "");
        }}
      />
    </div>
  );
}
