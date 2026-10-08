"use client";

import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";

import { ABAS_DA_COBRANCA, type AbaDaCobranca } from "./_abas-lista";

const ROTULO: Record<AbaDaCobranca, string> = {
  "visao-geral": "Visão geral",
  conexao: "Conexão",
  regua: "Régua",
  planos: "Planos",
  clientes: "Clientes",
};

/** As abas de /admin/cobranca. `key` remonta quando `?aba=` muda (link do checklist). */
export function AbasDaCobranca({ inicial, paineis }: { inicial: AbaDaCobranca; paineis: Record<AbaDaCobranca, ReactNode> }) {
  const t = useT();
  return (
    <Tabs key={inicial} defaultValue={inicial}>
      <TabsList className="flex h-auto flex-wrap">
        {ABAS_DA_COBRANCA.map((aba) => (
          <TabsTrigger key={aba} value={aba}>
            {t(ROTULO[aba])}
          </TabsTrigger>
        ))}
      </TabsList>
      {ABAS_DA_COBRANCA.map((aba) => (
        <TabsContent key={aba} value={aba} className="pt-4">
          {paineis[aba]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
