"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import type { Categoria } from "@/lib/schemas/precos";

/**
 * A árvore de categorias do catálogo. Raiz primeiro, filhas recuadas.
 * Criar/editar/apagar é `manager` — a rota cobra, a tela esconde o form.
 */
export function CategoriasClient({
  inicial,
  podeEditar,
}: {
  inicial: Categoria[];
  podeEditar: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [nome, setNome] = React.useState("");
  const [pai, setPai] = React.useState("");
  const [salvando, setSalvando] = React.useState(false);

  const raizes = inicial.filter((c) => !c.parent_id);
  const filhasDe = (id: string) => inicial.filter((c) => c.parent_id === id);

  async function salvar() {
    if (nome.trim().length < 2) {
      toast.error(t("O nome precisa de ao menos 2 letras"));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/categories", {
        nome: nome.trim(),
        ...(pai ? { parent_id: pai } : {}),
      });
      toast.success(t("Categoria criada"));
      setNome("");
      setPai("");
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function apagar(id: string) {
    if (!window.confirm(t("Apagar a categoria e as subcategorias? Os produtos ficam sem categoria."))) return;
    try {
      await apiClient.delete(`/api/v1/categories/${id}`);
      toast.success(t("Categoria apagada"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  return (
    <div className="space-y-4">
      {podeEditar && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="nova-categoria">{t("Nova categoria")}</Label>
            <Input
              id="nova-categoria"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex.: Bebidas")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="categoria-pai">{t("Dentro de (opcional)")}</Label>
            <select
              id="categoria-pai"
              className="rounded-lg border bg-background px-3 py-2 text-sm"
              value={pai}
              onChange={(e) => setPai(e.target.value)}
            >
              <option value="">{t("Raiz")}</option>
              {inicial.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={salvar} disabled={salvando}>
            {t(salvando ? "Salvando…" : "Criar categoria")}
          </Button>
        </div>
      )}

      {inicial.length === 0 ? (
        <p className="rounded-2xl border bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
          {t("Nenhuma categoria ainda — crie a primeira acima.")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-categorias">
          {raizes.map((r) => (
            <React.Fragment key={r.id}>
              <li className="flex items-center justify-between p-3">
                <span className="font-medium">{r.nome}</span>
                {podeEditar && (
                  <Button variant="ghost" size="sm" onClick={() => void apagar(r.id)}>
                    {t("Apagar")}
                  </Button>
                )}
              </li>
              {filhasDe(r.id).map((f) => (
                <li key={f.id} className="flex items-center justify-between p-3 pl-8 text-sm">
                  <span className="text-muted-foreground">↳ {f.nome}</span>
                  {podeEditar && (
                    <Button variant="ghost" size="sm" onClick={() => void apagar(f.id)}>
                      {t("Apagar")}
                    </Button>
                  )}
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
