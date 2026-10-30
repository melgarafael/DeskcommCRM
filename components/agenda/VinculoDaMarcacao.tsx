"use client";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { cn } from "@/lib/utils";

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
  const listaId = useId();
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState(false);
  const [destacado, setDestacado] = useState(0);
  const [criando, setCriando] = useState(false);
  const termo = busca.trim();
  const ficha = useQuery({
    queryKey: ["agenda", "vinculos", contactId],
    enabled: Boolean(contactId),
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams({ contact_id: contactId })}`,
        )
      ).data,
  });
  const lista = useQuery({
    queryKey: ["agenda", "vinculos", "q", termo],
    enabled: aberto,
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams(termo ? { q: termo } : {})}`,
        )
      ).data,
  });

  const contatos = lista.data?.contacts ?? [];
  const nomeDoSelecionado = ficha.data?.contacts[0]?.name;
  const valor = aberto || !contactId ? busca : (nomeDoSelecionado ?? busca);

  // Quem marca horário costuma estar com a pessoa na frente, e ela nem sempre
  // já é contato. Sem esta saída o fluxo PARA aqui: teria que abandonar a
  // marcação, ir até Contatos, criar, voltar e recomeçar. O termo já digitado
  // vira o nome, e o contato volta selecionado.
  const buscou = termo.length > 0 && !contactId;
  const nadaEncontrado = buscou && !lista.isLoading && contatos.length === 0;
  const opcoes = [
    { id: "", name: t("Compromisso pessoal, sem cliente") },
    ...contatos,
  ];

  function abrir() {
    setAberto(true);
    setDestacado(0);
    if (contactId && nomeDoSelecionado && !busca) setBusca(nomeDoSelecionado);
  }

  function escolher(id: string, nome: string) {
    setBusca(id ? nome : "");
    setAberto(false);
    onChange(id, "");
  }

  function aoDigitar(valorDigitado: string) {
    setBusca(valorDigitado);
    setAberto(true);
    setDestacado(0);
    // Digitar é procurar outro: o vínculo anterior não pode ficar preso no
    // id enquanto o texto já é de outra pessoa.
    if (contactId) onChange("", "");
  }

  function aoTeclar(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!aberto) abrir();
      else setDestacado((i) => Math.min(i + 1, opcoes.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const alvo = opcoes[destacado];
      if (alvo) escolher(alvo.id, alvo.name);
    } else if (e.key === "Escape") {
      setAberto(false);
      if (contactId && nomeDoSelecionado) setBusca(nomeDoSelecionado);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block">
          {t("Quem será atendido")}
          <div className="relative">
          <input
            id="quem-sera-atendido"
            data-testid="quem-sera-atendido"
            data-contact-id={contactId}
            role="combobox"
            aria-expanded={aberto}
            aria-controls={listaId}
            aria-autocomplete="list"
            aria-activedescendant={aberto ? `${listaId}-${destacado}` : undefined}
            className="mt-1 w-full rounded-md border bg-surface p-2 outline-hidden"
            value={valor}
            placeholder={t("Compromisso pessoal, sem cliente")}
            autoComplete="off"
            onFocus={abrir}
            onChange={(e) => aoDigitar(e.target.value)}
            onKeyDown={aoTeclar}
            onBlur={() => setAberto(false)}
          />
          {aberto ? (
            <ul
              id={listaId}
              role="listbox"
              className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-surface shadow-md"
              onMouseDown={(e) => e.preventDefault()}
            >
              {opcoes.map((opcao, i) => (
                <li
                  key={opcao.id || "pessoal"}
                  id={`${listaId}-${i}`}
                  role="option"
                  aria-selected={opcao.id === contactId}
                  className={cn(
                    "cursor-pointer px-3 py-2 text-sm",
                    i === destacado && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setDestacado(i)}
                  onClick={() => escolher(opcao.id, opcao.name)}
                >
                  {opcao.name}
                </li>
              ))}
              {nadaEncontrado ? (
                <li>
                  <button
                    type="button"
                    // Alvo de toque generoso: quem marca faz isso no celular, com o
                    // cliente esperando na frente.
                    className="min-h-11 w-full px-3 text-left text-sm"
                    onClick={() => setCriando(true)}
                  >
                    {t("Criar")} “{termo}”
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
          </div>
        </label>
      </div>
      {contactId ? (
        <label className="block">
          {t("Conversa vinculada (opcional)")}
          <select
            className="mt-1 w-full rounded-md border bg-surface p-2"
            value={conversationId}
            onChange={(e) => onChange(contactId, e.target.value)}
          >
            <option value="">{t("Sem conversa vinculada")}</option>
            {ficha.data?.conversations.map((c, i) => (
              <option key={c.id} value={c.id}>
                {t("Conversa")} {i + 1} · {new Date(c.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {ficha.isError || lista.isError ? (
        <p role="alert">{t("Não foi possível carregar os vínculos. Tente novamente.")}</p>
      ) : null}
      {/* `key` pelo termo: `nomeInicial` é defaultValue do formulário e só vale
          na montagem. Sem remontar, quem fecha e digita outro nome reabriria com
          o anterior. */}
      <NewContactDialog
        key={termo}
        open={criando}
        onOpenChange={setCriando}
        nomeInicial={termo}
        permitirIniciarConversa={false}
        onCriado={(contato) => {
          // Volta JÁ SELECIONADO. A busca passa a ser o nome do contato para a
          // lista conter quem acabou de nascer — senão o campo ficaria com um
          // valor que ele não sabe desenhar.
          setBusca(contato.name ?? termo);
          setAberto(false);
          onChange(contato.id, "");
        }}
      />
    </div>
  );
}
