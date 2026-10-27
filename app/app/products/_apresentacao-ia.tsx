"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  emptyCatalogProductPresentation,
  type CatalogProductPresentationPublic,
  type PresentationBlocker,
} from "@/lib/catalogo/apresentacao";
import { planCatalogPresentation } from "@/lib/catalogo/plano-de-apresentacao";
import {
  prepareCatalogPresentationPayloads,
  type PreparedCatalogPresentationPayload,
} from "@/lib/catalogo/preparo-de-apresentacao";
import type { Produto } from "@/lib/schemas/produtos";

type Envelope<T> = { data: T };

const BLOCKER_LABEL: Record<PresentationBlocker, string> = {
  incomplete_configuration: "Configuração incompleta: escreva o texto de apresentação.",
  missing_audio: "Áudio ausente: envie um arquivo antes de ativar.",
  missing_photos: "Fotos ausentes: cadastre fotos ou desative o uso das fotos.",
  physical_limit_exceeded: "O limite físico estimado de mensagens foi excedido.",
};

// A API pública confirma a existência do áudio sem expor o path privado. O
// planner precisa apenas de uma referência opaca para montar a sequência; a
// tela continua usando a URL assinada exclusivamente para reprodução.
const AUDIO_REFERENCE_FOR_PREVIEW = "preview/catalog-presentation.ogg";

function messageFrom(response: unknown, fallback: string): string {
  if (!response || typeof response !== "object" || !("error" in response)) return fallback;
  const error = (response as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : fallback;
}

export function CatalogProductAiPresentation({
  product,
  photoUrls,
}: {
  product: Produto;
  photoUrls: Record<string, string>;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [presentation, setPresentation] = React.useState<CatalogProductPresentationPublic | null>(
    null,
  );
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<Envelope<CatalogProductPresentationPublic>>(
        `/api/v1/products/${product.id}/ai-presentation`,
      );
      setPresentation(response.data);
    } catch (error) {
      showApiError(error);
    } finally {
      setLoading(false);
    }
  }, [product.id]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !presentation) await load();
  }

  const draft = presentation ?? emptyCatalogProductPresentation();
  const previewResult = planCatalogPresentation({
    ordered_product_codes: [product.codigo],
    resolved_items: [
      {
        product_id: product.id,
        product_code: product.codigo,
        product_name: product.nome,
        price_cents: product.preco_cents,
        currency: product.moeda,
        photo_storage_paths: product.fotos,
        presentation: {
          enabled: draft.enabled,
          kind: draft.kind,
          title: draft.title,
          text_content: draft.text_content,
          use_catalog_photos: draft.use_catalog_photos,
          show_price: draft.show_price,
          audio_storage_path: draft.has_audio ? AUDIO_REFERENCE_FOR_PREVIEW : null,
          audio_mime: draft.audio_mime,
        },
      },
    ],
  });
  const preparationResult = previewResult.ok
    ? prepareCatalogPresentationPayloads(previewResult.plan)
    : null;
  const previewPayloads = preparationResult?.ok ? preparationResult.prepared.payloads : null;
  const previewBlockers =
    !previewResult.ok && previewResult.error.code === "presentation_incomplete"
      ? previewResult.error.blockers
      : [];

  function renderPreviewPayload(payload: PreparedCatalogPresentationPayload) {
    switch (payload.kind) {
      case "text":
        return <span className="whitespace-pre-wrap">{payload.text}</span>;
      case "audio":
        return draft.audio_url ? (
          <audio
            controls
            src={draft.audio_url}
            className="w-full"
            data-testid="preview-apresentacao-audio"
          />
        ) : (
          t("Áudio OGG/Opus")
        );
      case "image": {
        const url = photoUrls[payload.media.storage_path];
        return (
          <div className="flex items-center gap-2">
            {url ? (
              // URL privada assinada pela página; não entra no build do Next Image.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={`${product.nome} — ${t("foto")} ${payload.position + 1}`}
                className="h-16 w-16 rounded-md border object-cover"
              />
            ) : null}
            <span>
              {t("Fotos cadastradas")} {payload.position + 1}
            </span>
          </div>
        );
      }
      case "price":
        return `${t("Preço")}: ${payload.text}`;
    }
  }

  function change(patch: Partial<CatalogProductPresentationPublic>) {
    setPresentation({ ...draft, ...patch });
  }

  async function save() {
    setSaving(true);
    try {
      const response = await apiClient.patch<Envelope<CatalogProductPresentationPublic>>(
        `/api/v1/products/${product.id}/ai-presentation`,
        {
          enabled: draft.enabled,
          kind: draft.kind,
          title: draft.title,
          text_content: draft.text_content,
          use_catalog_photos: draft.use_catalog_photos,
          show_price: draft.show_price,
          expected_updated_at: draft.updated_at,
        },
      );
      setPresentation(response.data);
      toast.success(t("Apresentação salva"));
    } catch (error) {
      showApiError(error);
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    setSaving(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("expected_updated_at", draft.updated_at ?? "null");
      const response = await fetch(`/api/v1/products/${product.id}/ai-presentation/audio`, {
        method: "POST",
        body: form,
      });
      const body = (await response.json().catch(() => null)) as
        Envelope<CatalogProductPresentationPublic> | { error?: { message?: string } } | null;
      if (!response.ok || !body || !("data" in body)) {
        toast.error(messageFrom(body, t("Não consegui enviar o áudio.")));
        return;
      }
      setPresentation(body.data);
      toast.success(t("Áudio salvo"));
    } catch {
      toast.error(t("Não consegui enviar o áudio."));
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeAudio() {
    setSaving(true);
    try {
      const response = await apiClient.delete<Envelope<CatalogProductPresentationPublic>>(
        `/api/v1/products/${product.id}/ai-presentation/audio`,
        { expected_updated_at: draft.updated_at },
      );
      setPresentation(response.data);
      toast.success(t("Áudio removido"));
    } catch (error) {
      showApiError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-md border bg-background" data-testid="apresentacao-ia">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-3 text-left text-sm font-medium"
        onClick={() => void toggle()}
        aria-expanded={open}
        data-testid="abrir-apresentacao-ia"
      >
        <span>{t("Apresentação pela IA")}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open ? (
        <div className="border-t p-3" data-testid="painel-apresentacao-ia">
          {loading && !presentation ? (
            <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => change({ enabled: event.target.checked })}
                    data-testid="apresentacao-ativa"
                  />
                  {t("Ativa")}
                </label>

                <fieldset className="flex items-center gap-4 text-sm">
                  <legend className="sr-only">{t("Tipo")}</legend>
                  {(["text", "audio"] as const).map((kind) => (
                    <label key={kind} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`presentation-kind-${product.id}`}
                        value={kind}
                        checked={draft.kind === kind}
                        onChange={() => change({ kind })}
                      />
                      {t(kind === "text" ? "Texto" : "Áudio")}
                    </label>
                  ))}
                </fieldset>

                <label className="text-sm sm:col-span-2">
                  {t("Título")} <span className="text-muted-foreground">{t("(opcional)")}</span>
                  <input
                    value={draft.title ?? ""}
                    onChange={(event) => change({ title: event.target.value || null })}
                    placeholder={product.nome}
                    maxLength={200}
                    className="mt-1 h-9 w-full rounded-md border px-3"
                    data-testid="apresentacao-titulo"
                  />
                </label>

                {draft.kind === "text" ? (
                  <label className="text-sm sm:col-span-2">
                    {t("Texto de apresentação")}
                    <textarea
                      value={draft.text_content ?? ""}
                      onChange={(event) => change({ text_content: event.target.value || null })}
                      rows={4}
                      maxLength={4096}
                      className="mt-1 w-full rounded-md border px-3 py-2"
                      data-testid="apresentacao-texto"
                    />
                  </label>
                ) : (
                  <div className="sm:col-span-2">
                    {draft.audio_url ? (
                      <audio
                        controls
                        src={draft.audio_url}
                        className="w-full"
                        data-testid="apresentacao-audio"
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("Nenhum áudio enviado.")}</p>
                    )}
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/ogg,audio/webm,video/webm,.ogg,.webm"
                      className="hidden"
                      data-testid="arquivo-apresentacao-audio"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void upload(file);
                      }}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={saving}
                        onClick={() => fileRef.current?.click()}
                      >
                        {t(draft.has_audio ? "Substituir áudio" : "Enviar áudio")}
                      </Button>
                      {draft.has_audio ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving}
                          onClick={() => void removeAudio()}
                        >
                          {t("Remover áudio")}
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("OGG/Opus ou WebM/Opus, até 16 MB. O arquivo é guardado como OGG/Opus.")}
                    </p>
                  </div>
                )}

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.use_catalog_photos}
                    onChange={(event) => change({ use_catalog_photos: event.target.checked })}
                    data-testid="apresentacao-usar-fotos"
                  />
                  {t("Usar fotos cadastradas")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.show_price}
                    onChange={(event) => change({ show_price: event.target.checked })}
                    data-testid="apresentacao-exibir-preco"
                  />
                  {t("Exibir preço")}
                </label>
              </div>

              <div
                className="mt-4 rounded-md border border-dashed p-3"
                data-testid="preview-apresentacao"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{t("Ordem futura de envio")}</p>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="quantidade-mensagens"
                  >
                    {preparationResult?.ok ? preparationResult.prepared.physical_payload_count : 0}{" "}
                    {t("mensagens físicas estimadas")}
                  </span>
                </div>
                {previewPayloads ? (
                  <ol className="space-y-2 text-sm">
                    {previewPayloads.map((payload, index) => (
                      <li
                        key={`${payload.kind}-${index}`}
                        className="flex items-start gap-2"
                        data-testid={`mensagem-apresentacao-${index}`}
                      >
                        <strong>{index + 1}.</strong>
                        <div className="min-w-0 flex-1">{renderPreviewPayload(payload)}</div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="estado-preview-apresentacao"
                  >
                    {!previewResult.ok && previewResult.error.code === "presentation_disabled"
                      ? `${t("Apresentação pela IA")}: ${t("Desativada")}`
                      : t("Configuração incompleta: escreva o texto de apresentação.")}
                  </p>
                )}
              </div>

              {previewBlockers.length > 0 ? (
                <div
                  className="mt-3 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg"
                  data-testid="bloqueios-apresentacao"
                >
                  <p className="font-medium">{t("Bloqueios")}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {previewBlockers.map((blocker) => (
                      <li key={blocker}>{t(BLOCKER_LABEL[blocker])}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <Button
                type="button"
                className="mt-4"
                disabled={
                  saving ||
                  (draft.enabled &&
                    (previewBlockers.length > 0 ||
                      Boolean(preparationResult && !preparationResult.ok)))
                }
                onClick={() => void save()}
                data-testid="salvar-apresentacao-ia"
              >
                {t(saving ? "Salvando…" : "Salvar apresentação")}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
