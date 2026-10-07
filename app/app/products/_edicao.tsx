"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  corpoDaEdicao,
  rascunhoDaEdicao,
  sincronizadoDeOrigem,
  type RascunhoDaEdicao,
} from "@/lib/catalogo/edicao-do-produto";
import type { Produto } from "@/lib/schemas/produtos";

/**
 * O FORMULÁRIO DE EDIÇÃO — o que a tela nunca teve.
 *
 * A tela só deixava criar, importar, desativar e mexer nas fotos; para
 * consertar um preço ou uma descrição era preciso reimportar a planilha, e a
 * planilha de propósito não grava nem `descricao` nem `ativo`. O `PATCH`
 * `/api/v1/products/:id` já aceitava mudança parcial desde o começo — faltava
 * quem o chamasse.
 *
 * As duas decisões têm régua própria, em `lib/catalogo/edicao-do-produto.ts`
 * (teste sem DOM): grava só o que mudou, e `origem` externa abre tudo
 * somente leitura com o aviso de que o lugar de editar é a origem — a próxima
 * sincronização sobrescreveria. Fotos seguem livres pelo botão de sempre: a
 * integração não mexe nelas.
 */
export function EdicaoDoProduto({ produto, aoFechar }: { produto: Produto; aoFechar: () => void }) {
  const t = useT();
  const router = useRouter();
  const [rascunho, setRascunho] = React.useState<RascunhoDaEdicao>(() => rascunhoDaEdicao(produto));
  const [salvando, setSalvando] = React.useState(false);

  const somenteLeitura = sincronizadoDeOrigem(produto.origem);
  const desabilitado = somenteLeitura || salvando;

  async function salvar() {
    const { corpo, erro } = corpoDaEdicao(rascunho, produto, t);
    if (erro) {
      toast.error(erro);
      return;
    }
    if (Object.keys(corpo).length === 0) {
      toast.error(t("Nada para alterar."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/products/${produto.id}`, corpo);
      toast.success(t("Produto atualizado"));
      aoFechar();
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="border-t bg-muted/30 p-3" data-testid={`edicao-${produto.codigo}`}>
      {somenteLeitura ? (
        <p
          className="mb-3 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg"
          data-testid="aviso-sincronizado"
        >
          {t("Sincronizado de")} {produto.origem}.{" "}
          {t("Edite na origem: o que você mudar aqui é sobrescrito na próxima sincronização.")}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          {t("Código")}
          <input
            value={rascunho.codigo}
            onChange={(e) => setRascunho({ ...rascunho, codigo: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-codigo"
          />
        </label>
        <label className="text-sm">
          {t("Nome")}
          <input
            value={rascunho.nome}
            onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-nome"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          {t("Descrição")}
          <textarea
            value={rascunho.descricao}
            onChange={(e) => setRascunho({ ...rascunho, descricao: e.target.value })}
            rows={3}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            disabled={desabilitado}
            data-testid="edicao-descricao"
          />
        </label>
        <label className="text-sm">
          {t("Marca")}
          <input
            value={rascunho.marca}
            onChange={(e) => setRascunho({ ...rascunho, marca: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-marca"
          />
        </label>
        <label className="text-sm">
          {t("Categoria")}
          <input
            value={rascunho.categoria}
            onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-categoria"
          />
        </label>
        <label className="text-sm">
          {t("Preço de venda")}
          <input
            value={rascunho.preco}
            onChange={(e) => setRascunho({ ...rascunho, preco: e.target.value })}
            placeholder="5.499,00"
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-preco"
          />
        </label>
        <label className="text-sm">
          {t("Custo")} <span className="text-muted-foreground">{t("(opcional)")}</span>
          <input
            value={rascunho.custo}
            onChange={(e) => setRascunho({ ...rascunho, custo: e.target.value })}
            placeholder="4.100,00"
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-custo"
          />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rascunho.controla_estoque}
          onChange={(e) => setRascunho({ ...rascunho, controla_estoque: e.target.checked })}
          disabled={desabilitado}
          data-testid="edicao-controla-estoque"
        />
        {t("Controlar estoque deste produto")}
      </label>
      {rascunho.controla_estoque ? (
        <label className="mt-2 block text-sm">
          {t("Quantidade")}
          <input
            value={rascunho.quantidade}
            onChange={(e) => setRascunho({ ...rascunho, quantidade: e.target.value })}
            className="mt-1 h-9 w-32 rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-quantidade"
          />
        </label>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        {somenteLeitura ? null : (
          <Button onClick={() => void salvar()} disabled={salvando} data-testid="salvar-edicao">
            {t(salvando ? "Salvando…" : "Salvar alterações")}
          </Button>
        )}
        <Button variant="ghost" onClick={aoFechar} data-testid="fechar-edicao">
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}
