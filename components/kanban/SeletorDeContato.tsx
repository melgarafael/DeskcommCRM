"use client";

import { useEffect, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { useContactList } from "@/hooks/contacts/useContactList";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { X } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";

/**
 * Escolher a PESSOA antes de abrir o negócio.
 *
 * Nada aqui é novo: a busca é o `GET /api/v1/contacts?search=`, que já casa
 * variações de telefone (`phoneLookupVariants`), e criar um contato é o
 * `NewContactDialog`, que já nasceu para ser aberto no meio de outro fluxo
 * (props `nomeInicial` e `onCriado`). O que faltava era o lugar de usar os dois.
 */

/** Quantos resultados cabem sem a lista virar rolagem dentro do diálogo. */
const RESULTADOS_NA_TELA = 8;

interface Props {
  escolhido: Contact | null;
  onEscolher: (contato: Contact | null) => void;
}

export function SeletorDeContato({ escolhido, onEscolher }: Props) {
  const t = useT();
  const [termo, setTermo] = useState("");
  const [busca, setBusca] = useState("");
  const [criando, setCriando] = useState(false);

  // Sem a espera, cada tecla vira uma consulta à API.
  useEffect(() => {
    const id = setTimeout(() => setBusca(termo.trim()), 250);
    return () => clearTimeout(id);
  }, [termo]);

  const lista = useContactList(busca ? { search: busca } : { limit: RESULTADOS_NA_TELA });
  const achados = (lista.data?.pages.flatMap((p) => p.data) ?? [])
    .filter((c) => !c.is_anonymized)
    .slice(0, RESULTADOS_NA_TELA);

  function escolher(contato: Contact) {
    onEscolher(contato);
    setTermo("");
    setCriando(false);
  }

  if (escolhido) {
    return (
      <div className="space-y-2">
        <Label>{t("Contato")}</Label>
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm">{rotuloDoContato(escolhido, t)}</p>
            {escolhido.phone_number && (
              <p className="truncate text-xs text-muted-foreground">
                {phoneForDisplay(escolhido.phone_number)}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("Trocar contato")}
            onClick={() => onEscolher(null)}
          >
            <X size={16} />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="contato-do-lead">{t("Contato")}</Label>
      <Input
        id="contato-do-lead"
        placeholder={t("Procure pelo nome ou telefone")}
        value={termo}
        onChange={(e) => setTermo(e.target.value)}
      />
      {achados.length > 0 && (
        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
          {achados.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted"
                onClick={() => escolher(c)}
              >
                <span className="text-sm">{rotuloDoContato(c, t)}</span>
                {c.phone_number && (
                  <span className="text-xs text-muted-foreground">
                    {phoneForDisplay(c.phone_number)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {busca !== "" && achados.length === 0 && !lista.isLoading && (
        <p className="text-xs text-muted-foreground">{t("Nenhum contato com esse nome ou telefone.")}</p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => setCriando(true)}>
        {t("Criar contato")}
      </Button>
      {criando && (
        <NewContactDialog
          // `nomeInicial` é defaultValue, então só vale na montagem: a chave
          // remonta o diálogo quando o termo muda.
          key={termo}
          open
          onOpenChange={setCriando}
          nomeInicial={termo}
          onCriado={escolher}
        />
      )}
    </div>
  );
}
