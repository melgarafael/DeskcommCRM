"use client";

import * as React from "react";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SeletorDeVariavel, type AtalhoDeVariavel } from "@/components/variaveis/SeletorDeVariavel";
import { PreviaComValores } from "@/components/variaveis/PreviaComValores";
import type { Resolvedor } from "@/lib/variaveis/catalogo";

/**
 * O CAMPO DE TEXTO COM VARIÁVEIS (#3687) — um só, para as quatro telas.
 *
 * Junta as três peças que antes cada tela reescrevia: o seletor (catálogo), o
 * campo (insere `{{chave}}` na posição do cursor) e a prévia (o que o cliente
 * lê). Nenhuma tela precisa saber que existe um catálogo; passa a FONTE.
 *
 * O cursor é calculado no `selectionStart` de agora, e não no fim do texto: quem
 * clica em "Inserir variável" com o cursor no meio da frase quer o token ali —
 * era o defeito do `insertVar` de cada tela, que cada uma tinha resolvido (ou
 * não) do seu jeito.
 */
export function CampoComVariaveis({
  id,
  rotulo,
  fonte,
  valor,
  onChange,
  placeholder,
  linhas = 4,
  extras,
  ajuda,
  obrigatorio,
  maxLength,
}: {
  id?: string;
  rotulo: string;
  fonte: Resolvedor;
  valor: string;
  onChange: (texto: string) => void;
  placeholder?: string;
  linhas?: number;
  extras?: readonly AtalhoDeVariavel[];
  /** Texto de apoio abaixo da prévia. */
  ajuda?: string;
  obrigatorio?: boolean;
  maxLength?: number;
}) {
  const campoRef = React.useRef<HTMLTextAreaElement>(null);
  // `useId` é HOOK: chamado incondicionalmente, e só o valor é descartado quando
  // quem chama já passou um `id`. Antes ele morava no `??`, que o React lê como
  // chamada condicional (React.useId dentro de expressão curto-circuitada).
  const idGerado = React.useId();
  const idDoCampo = id ?? idGerado;

  const inserir = (token: string) => {
    const el = campoRef.current;
    const inicio = el?.selectionStart ?? valor.length;
    const fim = el?.selectionEnd ?? valor.length;
    const proximo = valor.slice(0, inicio) + token + valor.slice(fim);
    onChange(proximo);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inicio + token.length, inicio + token.length);
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={idDoCampo}>{rotulo}</Label>
        <SeletorDeVariavel fonte={fonte} onInserir={inserir} extras={extras} />
      </div>
      <Textarea
        id={idDoCampo}
        ref={campoRef}
        rows={linhas}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={obrigatorio}
        maxLength={maxLength}
      />
      <PreviaComValores texto={valor} fonte={fonte} />
      {ajuda ? <p className="text-xs text-muted-foreground">{ajuda}</p> : null}
    </div>
  );
}
