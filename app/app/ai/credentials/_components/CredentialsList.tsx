"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Plus } from "@/lib/ui/icons";
import {
  ehProvedorDeDecisao,
  ehProvedorSuportado,
  PROVEDORES_COM_CHAVE,
  type ProvedorComChave,
} from "@/lib/ai/pontos/provedores";
import { credentialStatus, useCredentialsList, type CredentialRow } from "@/hooks/ai/useCredentials";
import { credencialEmUsoPeloJev } from "@/lib/ai/decisao/credencial";
import { avisoAoExcluirAChaveDoJev } from "@/lib/ai/decisao/textos";
import { useT } from "@/hooks/i18n/useT";
import { CredentialCard } from "./CredentialCard";
import { AddCredentialDialog } from "./AddCredentialDialog";

interface Props {
  initialData: CredentialRow[];
  canWrite: boolean;
  usageMap: Record<string, number>;
  /**
   * O Jev LIGADO: as tarefas dele e se há IA principal para medir sem ele
   * (`page.tsx`). Qual chave ele usa sai da lista viva, aqui — ver `doJev`.
   */
  jev?: { tarefas: readonly string[]; temIaPrincipal: boolean } | null;
  /**
   * A instalação trouxe chave de IA no `.env` (a do provedor ou a do gateway)?
   * É o caso mais comum do kit, e essa chave não é linha desta lista.
   */
  instalacaoTemIa?: boolean;
}

// Rótulo e ordem saem das listas — provedor novo aparece na tela sem que
// alguém precise lembrar de acrescentá-lo em três lugares. A UNIÃO, porque a
// chave do Jev (que só decide) também mora aqui.
const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  PROVEDORES_COM_CHAVE.map((p) => [p.id, p.rotulo]),
);

const PROVIDER_ORDER: ProvedorComChave[] = PROVEDORES_COM_CHAVE.map((p) => p.id);

export function CredentialsList({
  initialData,
  canWrite,
  usageMap,
  jev = null,
  instalacaoTemIa = false,
}: Props) {
  const t = useT();
  const { data } = useCredentialsList({ initialData });
  const [addOpen, setAddOpen] = useState(false);

  const credentials = data ?? [];

  // Construído a partir da lista única: escrito à mão, o dia em que um
  // provedor novo entra é o dia em que as credenciais dele somem da tela sem
  // ninguém ver (aconteceu com a OpenRouter).
  const grouped: Partial<Record<ProvedorComChave, CredentialRow[]>> = Object.fromEntries(
    PROVEDORES_COM_CHAVE.map((p) => [p.id, [] as CredentialRow[]]),
  );
  for (const c of credentials) {
    grouped[c.provider]?.push(c);
  }

  // A chave que o Jev usa, pela mesma regra que a escolhe para a rede, sobre a
  // lista que a tela relê: trocar a chave tira a linha "Usada em" enquanto a
  // nova é testada (ela não sai para a rede) e a devolve quando passa.
  const doJev = jev ? credencialEmUsoPeloJev(credentials) : null;
  const avisoAoExcluirOJev =
    !doJev || !jev
      ? undefined
      : avisoAoExcluirAChaveDoJev({
          temOutraChave: credencialEmUsoPeloJev(credentials.filter((c) => c.id !== doJev.id)) !== null,
          tarefas: jev.tarefas,
          temIaPrincipal: jev.temIaPrincipal,
        });

  // Só a chave do Jev não faz o atendimento funcionar: ele decide, não conversa.
  // Sem este aviso a tela sairia do estado vazio e pareceria pronta. Mas quem
  // atende com a chave que veio na instalação JÁ tem a IA principal: avisar ali
  // seria alarme falso sobre o que está funcionando.
  const soDecisao =
    !instalacaoTemIa &&
    credentials.some((c) => ehProvedorDeDecisao(c.provider)) &&
    // A chave de conversa RECUSADA não atende ninguém. A que ainda está em
    // teste conta: sem isso o aviso piscaria nos segundos depois de colar.
    !credentials.some(
      (c) => c.is_active && ehProvedorSuportado(c.provider) && credentialStatus(c) !== "invalid",
    );

  if (credentials.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <h2 className="font-medium">{t("Nenhuma chave cadastrada ainda")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t(
              "Seus agentes só conseguem pensar depois que você cola aqui uma chave da Anthropic, da OpenAI ou do Google. A cobrança vai direto para a sua conta no provedor, e a chave fica guardada criptografada.",
            )}
          </p>
          {canWrite && (
            <Button className="mt-1" onClick={() => setAddOpen(true)}>
              <Plus size={14} aria-hidden className="mr-2" /> {t("Adicionar credencial")}
            </Button>
          )}
        </Card>
        <AddCredentialDialog open={addOpen} onOpenChange={setAddOpen} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {soDecisao && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4" data-testid="aviso-so-decisao">
          <p className="text-sm">
            {t("O Jev não conversa com o cliente — falta a chave da sua IA principal.")}
          </p>
        </Card>
      )}
      <div className="flex sm:justify-end">
        {canWrite && (
          <Button onClick={() => setAddOpen(true)} className="w-full sm:w-auto">
            <Plus size={14} aria-hidden className="mr-2" /> {t("Adicionar credencial")}
          </Button>
        )}
      </div>
      {PROVIDER_ORDER.map((p) => {
        // `?? []` porque a lista de provedores pode crescer sem que exista
        // credencial daquele provedor — o agrupamento só tem chave para quem
        // tem linha.
        const rows = grouped[p] ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={p} className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              {PROVIDER_LABELS[p]}
            </h2>
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {rows.map((row) => (
                <li key={row.id}>
                  <CredentialCard
                    credential={row}
                    canWrite={canWrite}
                    usageCount={usageMap[row.id] ?? 0}
                    usadaEm={row.id === doJev?.id ? jev?.tarefas : undefined}
                    avisoAoExcluir={row.id === doJev?.id ? avisoAoExcluirOJev : undefined}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <AddCredentialDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
