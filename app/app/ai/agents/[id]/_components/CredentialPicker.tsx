"use client";
import * as React from "react";
import Link from "next/link";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import {
  type CredentialRow,
  type Provider,
  credentialStatus,
} from "@/hooks/ai/useCredentials";

interface Props {
  provider: Provider;
  credentials: CredentialRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string;
  /** A instalação tem chave deste provedor no `.env`? */
  instalacaoTemChave?: boolean;
}

export const STATUS_LABEL: Record<ReturnType<typeof credentialStatus>, string> = {
  validated: "validada",
  validating: "validando",
  unvalidated: "não validada",
  invalid: "inválida",
  inactive: "inativa",
};

/**
 * O valor que representa "a chave que veio na instalação".
 *
 * Um `<SelectItem>` não aceita valor vazio, e o vazio já significa "não
 * escolhida" no formulário — daí o token. Ele NÃO chega ao servidor: o
 * formulário o traduz em `credential_id: null`, que é o contrato da versão.
 */
export const CHAVE_DA_INSTALACAO = "__instalacao__";

export function CredentialPicker({
  provider,
  credentials,
  value,
  onChange,
  disabled,
  id,
  instalacaoTemChave = false,
}: Props) {
  const t = useT();
  const filtered = credentials.filter((c) => c.provider === provider);
  // Sem nenhuma das duas origens não há o que escolher — e é aí que o atalho
  // para cadastrar precisa aparecer.
  const semOpcao = filtered.length === 0 && !instalacaoTemChave;
  const opcoes: OpcaoDeSelecao[] = [
    // A chave do `.env` é o caso MAIS COMUM do produto — quem instala pelo
    // kit cola a chave no terminal e nunca abre a tela de Credenciais. O
    // runtime sempre soube usá-la; só esta tela não deixava escolhê-la, e o
    // resultado era um editor onde o dono não conseguia salvar nada.
    ...(instalacaoTemChave
      ? [{ value: CHAVE_DA_INSTALACAO, label: `${t("A chave desta instalação")} (${provider})` }]
      : []),
    ...filtered.map((c) => ({
      value: c.id,
      label: `${c.label} · …${c.api_key_last4 ?? "????"} · ${t(STATUS_LABEL[credentialStatus(c)])}`,
    })),
    ...(semOpcao
      ? [
          {
            value: "__none__",
            label: `${t("Nenhuma credencial")} ${provider} ${t("cadastrada")}`,
            disabled: true,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Chave de acesso")}</Label>
      <SearchableSelect
        id={id}
        options={opcoes}
        value={value || undefined}
        onValueChange={onChange}
        disabled={disabled}
        placeholder={t("Escolha uma chave")}
      />
      {semOpcao ? (
        <p className="text-xs text-muted-foreground">
          <Link
            href="/app/ai/credentials"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("Cadastrar credencial")} {provider}
          </Link>{" "}
          {t("na aba Credenciais.")}
        </p>
      ) : null}
    </div>
  );
}

export function findCredential(credentials: CredentialRow[], id: string): CredentialRow | null {
  return credentials.find((c) => c.id === id) ?? null;
}
