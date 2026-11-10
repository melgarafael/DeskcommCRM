"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { atualizarInterfaceDaEmpresa } from "@/app/actions/settings/atualizarInterfaceDaEmpresa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InterfaceEditor } from "@/components/team/InterfaceEditor";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import type { Role } from "@/lib/auth/types";
import { lerInterface, MAX_CAMPOS_DE_COMPRA, type InterfaceSettings } from "@/lib/navigation/interface";
import type { CustomFieldDef } from "@/lib/schemas/settings";

interface Props {
  /** O que está gravado hoje em `organizations.interface_settings`. */
  initial: unknown;
  /** Papel de quem edita: limita as opções ao que este papel enxerga. */
  role: Role;
  /** Os campos do NEGÓCIO declarados nos funis (issue #3179), para escolher até 3. */
  camposDeCompra?: CustomFieldDef[];
}

/**
 * Editor do menu lateral da EMPRESA (issue #1341), em Configurações → Empresa.
 * Reusa o mesmo editor da escolha por vínculo de propósito: é a mesma pergunta
 * num nível acima, e duas telas com a mesma semântica divergem com o tempo.
 */
export function InterfaceDaEmpresaForm({ initial, role, camposDeCompra = [] }: Props) {
  const t = useT();
  const [value, setValue] = useState<InterfaceSettings>(() => lerInterface(initial).settings);
  const [isPending, startTransition] = useTransition();

  const escolhidosDeCompra = value.compras_campos ?? [];

  function alternarCampoDeCompra(chave: string, marcado: boolean) {
    setValue((current) => {
      const atual = current.compras_campos ?? [];
      const proximos = marcado
        ? [...atual, chave].slice(0, MAX_CAMPOS_DE_COMPRA)
        : atual.filter((k) => k !== chave);
      // Vazio sai como ausência, não como `[]`: a chave não fica gravada quando a
      // empresa não escolheu nada — e a leitura cai no padrão (data, título, valor).
      if (proximos.length === 0) {
        return { preset: current.preset, ...(current.destinos ? { destinos: current.destinos } : {}) };
      }
      return { ...current, compras_campos: proximos };
    });
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await atualizarInterfaceDaEmpresa(value);
      if (resultado.ok) {
        toast.success(t("Menu lateral da empresa salvo."));
        return;
      }
      if (resultado.error === "mfa_required") return irAoDesafioDeMfa();
      toast.error(t("Não foi possível salvar o menu da empresa."));
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("Menu lateral")}</h2>
      <p className="text-xs text-muted-foreground">
        {t(
          "Escolha as áreas que esta empresa mostra. Cada pessoa escolhe menos do que isto em Equipe — nunca mais — e as áreas essenciais continuam sempre visíveis. As permissões não mudam: o que o papel autoriza segue acessível por link, aviso e busca.",
        )}
      </p>
      <InterfaceEditor
        value={value}
        onChange={(next) =>
          setValue((current) => {
            // O editor de menu reconstrói `{preset, destinos}`: sem devolver o
            // `compras_campos` por cima, trocar uma área apagaria a escolha dos
            // campos de compra — que vive no MESMO jsonb.
            const { compras_campos } = current;
            return compras_campos ? { ...next, compras_campos } : next;
          })
        }
        role={role}
        disabled={isPending}
      />
      {/*
        ÚLTIMAS COMPRAS (issue #3179): quais campos personalizados do NEGÓCIO a
        linha da compra mostra (destino, hospedagem, tipo de serviço). Sem escolha,
        a seção mostra só data, título e valor. É preferência da EMPRESA, no mesmo
        lugar onde ela já escolhe as áreas — nada de tela nova.
      */}
      {camposDeCompra.length > 0 && (
        <fieldset disabled={isPending} className="space-y-2 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">{t("Últimas compras")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "Escolha até {max} campos do negócio para aparecerem em cada compra do contato. Sem escolha, a seção mostra a data do ganho, o título e o valor.",
            ).replace("{max}", String(MAX_CAMPOS_DE_COMPRA))}
          </p>
          {camposDeCompra.map((campo) => (
            <label key={campo.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`compra-campo-${campo.key}`}
                checked={escolhidosDeCompra.includes(campo.key)}
                disabled={isPending || (!escolhidosDeCompra.includes(campo.key) && escolhidosDeCompra.length >= MAX_CAMPOS_DE_COMPRA)}
                onChange={(e) => alternarCampoDeCompra(campo.key, e.target.checked)}
                className="mt-1"
              />
              {campo.label}
            </label>
          ))}
        </fieldset>
      )}
      <Button type="button" size="sm" disabled={isPending} onClick={salvar}>
        {t("Aplicar interface")}
      </Button>
    </Card>
  );
}
