"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { ContatoAutorizadoDoTeste } from "@/lib/ai/agents/contato-do-teste";

export function ContatoDoTeste({
  value,
  onChange,
  disabled,
}: {
  value: ContatoAutorizadoDoTeste | null;
  onChange: (contato: ContatoAutorizadoDoTeste | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [termo, setTermo] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTermo(busca.trim()), 300);
    return () => clearTimeout(timer);
  }, [busca]);
  const query = useQuery({
    queryKey: ["contacts", "teste-do-agente", termo],
    enabled: !value && termo.length >= 3,
    queryFn: () =>
      apiClient.get<{
        data: Array<
          ContatoAutorizadoDoTeste & {
            is_anonymized?: boolean;
            is_blocked?: boolean;
            kind?: string;
          }
        >;
      }>(`/api/v1/contacts?${new URLSearchParams({ search: termo, limit: "10" })}`),
  });
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Label htmlFor="test-contact-search">{t("Consultar um contato cadastrado (opcional)")}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Ao selecionar, este teste pode ler os dados desse contato. Nenhuma mensagem é enviada. Nome e telefone de amostra não autorizam essa consulta.",
        )}
      </p>
      {value ? (
        <div className="flex items-center justify-between gap-2">
          <span>{value.name ?? value.phone_number}</span>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setBusca("");
            }}
          >
            {t("Remover contato do teste")}
          </Button>
        </div>
      ) : (
        <>
          <Input
            id="test-contact-search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            disabled={disabled}
            placeholder={t("Digite pelo menos três caracteres para buscar")}
          />
          {query.isFetching ? <p role="status">{t("Buscando contatos…")}</p> : null}
          {query.isError ? (
            <p role="alert">{t("Não foi possível buscar os contatos. Tente novamente.")}</p>
          ) : null}
          {query.data ? (
            <ul className="space-y-1">
              {query.data.data
                .filter((c) => !c.is_anonymized && !c.is_blocked && c.kind !== "whatsapp_group")
                .map((c) => (
                  <li key={c.id}>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onChange(c)}
                    >
                      {c.name ?? c.phone_number}
                    </Button>
                  </li>
                ))}
            </ul>
          ) : null}
          {query.data?.data.length === 0 ? <p>{t("Nenhum contato encontrado.")}</p> : null}
        </>
      )}
    </div>
  );
}
