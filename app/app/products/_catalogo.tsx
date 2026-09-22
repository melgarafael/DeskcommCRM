"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import type { Produto } from "@/lib/schemas/produtos";
import type { Categoria, TabelaDePreco } from "@/lib/schemas/precos";

import { ProdutosClient } from "./_client";
import { CategoriasClient } from "./_categorias";
import { TabelasClient } from "./_tabelas";

/**
 * O CATÁLOGO EM ABAS — produtos, categorias e tabelas de preço no mesmo lugar.
 *
 * Sem entrada nova na sidebar de propósito: catálogo é um módulo só, e o
 * grupo CRM já tem Funis, Contatos, Produtos e Pedidos na dobra.
 */
export function CatalogoClient({
  produtos,
  categorias,
  tabelas,
  podeEditar,
  textosProdutos,
}: {
  produtos: Produto[];
  categorias: Categoria[];
  tabelas: TabelaDePreco[];
  podeEditar: boolean;
  textosProdutos: React.ComponentProps<typeof ProdutosClient>["textos"];
}) {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text">{t("Catálogo")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Produtos, categorias e tabelas de preço da loja.")}
        </p>
      </header>
      <Tabs defaultValue="produtos">
        <TabsList>
          <TabsTrigger value="produtos">{t("Produtos")}</TabsTrigger>
          <TabsTrigger value="categorias">{t("Categorias")}</TabsTrigger>
          <TabsTrigger value="tabelas">{t("Tabelas de preço")}</TabsTrigger>
        </TabsList>
        <TabsContent value="produtos" className="mt-4">
          <ProdutosClient
            inicial={produtos}
            podeEditar={podeEditar}
            textos={textosProdutos}
            esconderCabecalho
          />
        </TabsContent>
        <TabsContent value="categorias" className="mt-4">
          <CategoriasClient inicial={categorias} podeEditar={podeEditar} />
        </TabsContent>
        <TabsContent value="tabelas" className="mt-4">
          <TabelasClient inicial={tabelas} produtos={produtos} podeEditar={podeEditar} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
