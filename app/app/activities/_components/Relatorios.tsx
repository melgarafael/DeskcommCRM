"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";

import { ActivityReportClient } from "./ActivityReportClient";
import { TagReportClient } from "./TagReportClient";

/**
 * Relatórios (`/app/activities`) em DUAS abas — Atividades e Por etiqueta
 * (#1891).
 *
 * A porta no menu continua sendo a entrada `/app/activities` de
 * `lib/navigation/catalogo.ts` (sidebar do grupo Análise): a aba é navegação
 * interna da tela, como Atendimento em `/app/team` e as de Conexões.
 * `tests/unit/navegacao-completude.test.ts` recusa href com query string no
 * registro ("todo destino do registro aponta para uma tela que existe"), então
 * registrar `/app/activities?aba=etiquetas` reprovaria o gate — quem chega
 * aqui chega pela porta que já existe, e `?aba=` deixa a aba endereçável.
 *
 * `defaultValue` e não `value`: como em `/app/team`, quem troca de aba não
 * briga com o histórico — o parâmetro só escolhe por onde a tela ABRIR.
 */
export function Relatorios({ abaInicial }: { abaInicial: string }) {
  const t = useT();
  return (
    <Tabs defaultValue={abaInicial} className="flex flex-1 flex-col">
      <TabsList>
        <TabsTrigger value="atividades">{t("Atividades")}</TabsTrigger>
        <TabsTrigger value="etiquetas">{t("Por etiqueta")}</TabsTrigger>
      </TabsList>
      <TabsContent value="atividades" className="mt-4 flex flex-col gap-6">
        <ActivityReportClient />
      </TabsContent>
      <TabsContent value="etiquetas" className="mt-4 flex flex-col gap-6">
        <TagReportClient />
      </TabsContent>
    </Tabs>
  );
}
