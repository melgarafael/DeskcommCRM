"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useT } from "@/hooks/i18n/useT";
import { ehPermissaoDeArea } from "@/lib/extensions/areas";
import {
  ehAreaSensivel,
  fraseDaPermissaoDeArea,
  type PermissaoDeArea,
} from "@/lib/extensions/portas-legiveis";
import type { InstalledExtensionView } from "@/lib/extensions/view";
import { CircleNotch } from "@/lib/ui/icons";

/**
 * O consentimento por área de um módulo `connected` (spec 33, F3, tarefa 5): das áreas que o pacote
 * DECLAROU, a organização marca as que o módulo pode alcançar. Marcar não dá acesso por si só: quem
 * decide a cada chamada é o servidor (`resolveAuthDual`), que lê este consentimento na hora.
 *
 * Só o administrador da organização altera. Manager e agent veem o consentimento atual, sem poder
 * mexer, e a tela diz o motivo. A conferência de verdade é do servidor (rota e função do banco): esta
 * tela não é a barreira.
 */
export function ConsentimentoPorArea({
  extension,
  canEdit,
  blockedReason,
  actionsDisabled,
  onSave,
}: {
  extension: InstalledExtensionView;
  /** Só o administrador da organização, fora do acompanhamento de suporte. */
  canEdit: boolean;
  /** Por que NÃO pode alterar (já traduzido); ignorado quando `canEdit`. */
  blockedReason?: string;
  actionsDisabled: boolean;
  /** Devolve `true` quando salvou. Quem chama dá a mensagem de sucesso ou de erro. */
  onSave?: (extension: InstalledExtensionView, areas: PermissaoDeArea[]) => Promise<boolean>;
}) {
  const t = useT();
  const declaradas = extension.permissions.filter(ehPermissaoDeArea) as PermissaoDeArea[];
  // Só vale o consentimento de área que o pacote ainda declara (a versão pode ter mudado).
  const gravadas = (extension.consented_areas ?? []).filter((area): area is PermissaoDeArea =>
    declaradas.includes(area as PermissaoDeArea),
  );
  const [marcadas, setMarcadas] = useState<PermissaoDeArea[]>(gravadas);
  const [salvando, setSalvando] = useState(false);

  const mudou =
    marcadas.length !== gravadas.length || marcadas.some((area) => !gravadas.includes(area));
  // Ativar vem antes: a função do banco recusa consentir sem a ativação desta organização.
  const ativada = extension.enabled;
  const editavel = canEdit && ativada && Boolean(onSave);
  const haSensivel = declaradas.some(ehAreaSensivel);

  function alternar(area: PermissaoDeArea, ligada: boolean) {
    setMarcadas((atual) =>
      ligada ? (atual.includes(area) ? atual : [...atual, area]) : atual.filter((a) => a !== area),
    );
  }

  async function salvar() {
    if (!onSave || salvando) return;
    setSalvando(true);
    try {
      await onSave(extension, marcadas);
    } finally {
      setSalvando(false);
    }
  }

  const motivo = !canEdit
    ? blockedReason
    : !ativada
      ? t("Ative o módulo nesta organização para escolher as áreas.")
      : undefined;

  return (
    <section
      className="mt-4 space-y-3 rounded-md border border-border bg-surface-elevated/40 p-3"
      data-testid={`extension-consent-${extension.id}`}
    >
      <div>
        <h3 className="text-sm font-semibold">{t("Áreas do CRM que este módulo pode usar")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            "O módulo só alcança o que o pacote pede e o que você marcar aqui. Tirar uma marca vale na hora.",
          )}
        </p>
      </div>

      {declaradas.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid={`extension-consent-none-${extension.id}`}>
          {t("Este módulo não pede acesso a nenhuma área do CRM.")}
        </p>
      ) : (
        <>
          {haSensivel ? (
            <p
              className="rounded-md border border-warning/30 bg-warning-bg p-2 text-xs text-warning-fg"
              data-testid={`extension-consent-sensitive-${extension.id}`}
            >
              {t(
                "Configuração e agentes de IA são áreas sensíveis: mexem no funcionamento da organização e do atendimento. Libere só para um módulo em que você confia.",
              )}
            </p>
          ) : null}
          <ul className="space-y-2">
            {declaradas.map((area) => {
              const id = `consent-${extension.id}-${area}`;
              return (
                <li key={area} className="flex items-start gap-2">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-0.5"
                    data-testid={`extension-consent-${extension.id}-${area}`}
                    checked={marcadas.includes(area)}
                    disabled={!editavel || actionsDisabled || salvando}
                    onChange={(event) => alternar(area, event.target.checked)}
                  />
                  <label htmlFor={id} className="text-sm leading-snug">
                    {fraseDaPermissaoDeArea(area, t)}
                    {ehAreaSensivel(area) ? (
                      <Badge variant="warning" className="ml-2 align-middle">
                        {t("Sensível")}
                      </Badge>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {motivo ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`extension-consent-reason-${extension.id}`}
        >
          {motivo}
        </p>
      ) : null}

      {editavel && declaradas.length > 0 ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            data-testid={`extension-consent-save-${extension.id}`}
            disabled={!mudou || actionsDisabled || salvando}
            onClick={() => void salvar()}
          >
            {salvando ? <CircleNotch className="animate-spin" aria-hidden /> : null}
            {salvando ? t("Salvando…") : t("Salvar áreas")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
