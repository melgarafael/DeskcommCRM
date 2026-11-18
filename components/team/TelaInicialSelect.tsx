"use client";

import { useId } from "react";

import { useT } from "@/hooks/i18n/useT";
import type { Role } from "@/lib/auth/types";
import {
  destinosDaInterface,
  essencial,
  type InterfaceSettings,
} from "@/lib/navigation/interface";

/**
 * "Tela inicial" (#4864): a porta que abre logo depois de entrar.
 *
 * A lista de opções são as portas que a PESSOA enxerga hoje — as essenciais
 * ficam de fora porque já estão sempre disponíveis, e escolher "Perfil" como
 * entrada não é o pedido de quem opera um nicho. `visiveis` é quem decide esse
 * conjunto: na empresa, a própria escolha em edição; no vínculo, a INTERSEÇÃO
 * com a empresa (`combinarInterfaces`), para a tela não oferecer uma porta que
 * o login não vai abrir.
 *
 * Isto é APRESENTAÇÃO, nunca autorização: nada aqui concede acesso, e a escolha
 * gravada só é obedecida por `homeDaInterface` enquanto a porta estiver visível.
 */
export function TelaInicialSelect({
  value,
  onChange,
  role,
  visiveis,
  disabled = false,
}: {
  value: InterfaceSettings["inicio"];
  onChange: (inicio: InterfaceSettings["inicio"]) => void;
  role: Role;
  /** O que decide quais portas estão na tela (a empresa, ou empresa ∩ vínculo). */
  visiveis: unknown;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const opcoes = destinosDaInterface(visiveis, false, role).filter((d) => !essencial(d, role));
  // Escolha que não está (mais) entre as opções aparece como PADRÃO: mostrar uma
  // porta que a pessoa não enxerga faria a tela prometer o que a entrada não faz.
  const atual = value && opcoes.some((d) => d.href === value) ? value : "";
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {t("Tela inicial")}
      </label>
      <p className="text-xs text-muted-foreground">
        {t(
          "Por onde o sistema abre depois de entrar. Sem escolha, abre o Inbox — ou a primeira área do menu, quando o Inbox estiver oculto. A escolha não muda permissões: se a área for ocultada depois, a entrada volta ao padrão.",
        )}
      </p>
      <select
        id={id}
        data-testid="tela-inicial"
        value={atual}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value ? (e.target.value as InterfaceSettings["inicio"]) : undefined)
        }
        className="h-10 w-full rounded-md border bg-background px-3 text-sm max-md:min-h-11"
      >
        <option value="">{t("Padrão do sistema")}</option>
        {opcoes.map((d) => (
          <option key={d.href} value={d.href}>
            {t(d.label)}
          </option>
        ))}
      </select>
    </div>
  );
}
