"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { LightboxDeFotos } from "@/components/fotos/LightboxDeFotos";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";

interface Foto {
  id: string;
  url: string;
  posicao: number;
}

/**
 * As fotos de um produto na lista: capa (primeira) + gerência.
 *
 * Carrega sob demanda por produto (a lista traz 500; trazer foto de todos
 * seria 500 consultas). Upload imediato no file input; apagar com ×.
 */
export function FotosDoProduto({
  productId,
  podeEditar,
}: {
  productId: string;
  podeEditar: boolean;
}) {
  const t = useT();
  const [fotos, setFotos] = React.useState<Foto[] | null>(null);
  const [ampliada, setAmpliada] = React.useState<number | null>(null);

  const recarregar = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: Foto[] }>(`/api/v1/products/${productId}/images`);
      setFotos(Array.isArray(corpo?.data) ? corpo.data : []);
    } catch (e) {
      showApiError(e);
    }
  }, [productId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  async function enviar(arquivo: File | undefined) {
    if (!arquivo) return;
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch(`/api/v1/products/${productId}/images`, { method: "POST", body: form });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(corpo?.error?.message ?? t("Não consegui enviar a foto."));
        return;
      }
      toast.success(t("Foto adicionada"));
      await recarregar();
    } catch {
      toast.error(t("Não consegui enviar a foto."));
    }
  }

  async function apagar(fotoId: string) {
    try {
      await apiClient.delete(`/api/v1/products/${productId}/images/${fotoId}`);
      await recarregar();
    } catch (e) {
      showApiError(e);
    }
  }

  if (fotos === null || fotos.length === 0) {
    return podeEditar ? (
      <label className="cursor-pointer text-xs text-muted-foreground underline">
        {t("＋ foto")}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            void enviar(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
    ) : null;
  }

  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setAmpliada(0)}
        aria-label={t("Ampliar foto")}
        title={t("Ampliar foto")}
        className="rounded-lg transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-primary"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={fotos[0]!.url}
          alt=""
          className="h-10 w-10 rounded-lg border object-cover"
          loading="lazy"
        />
      </button>
      {fotos.length > 1 && (
        <button
          type="button"
          onClick={() => setAmpliada(0)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          aria-label={t("Ver todas as fotos")}
        >
          +{fotos.length - 1}
        </button>
      )}
      {podeEditar && (
        <>
          <label className="cursor-pointer text-xs text-muted-foreground underline">
            {t("＋")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                void enviar(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs"
            onClick={() => void apagar(fotos[0]!.id)}
            aria-label={t("Apagar foto")}
          >
            ×
          </Button>
        </>
      )}
      <LightboxDeFotos
        fotos={fotos.map((f) => ({ url: f.url }))}
        indiceInicial={ampliada ?? 0}
        aberto={ampliada !== null}
        onFechar={() => setAmpliada(null)}
      />
    </span>
  );
}
