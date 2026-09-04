"use client";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useSyncTemplates,
  useTemplates,
  type TemplatePreview,
} from "@/hooks/channels/useTemplates";
import { useT } from "@/hooks/i18n/useT";

/** Só APPROVED pode ser disparado — o resto é informação, não opção. */
function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED" || status === "DISABLED") return "destructive";
  if (status === "PENDING") return "secondary";
  return "outline";
}

/**
 * O preview é a peça central desta tela. A Meta **não devolve** valores de exemplo
 * (`example` vem null nos templates reais), então o único jeito de o operador saber
 * o que preencher é ver o texto ao redor do parâmetro.
 *
 * O texto aparece INTEIRO e uma vez só, com todos os `{{n}}` marcados. A versão
 * anterior repetia o corpo a cada slot — cada linha destacava o seu e deixava o
 * vizinho cru, o que é tecnicamente correto e ilegível.
 */
function Preview({ preview }: { preview: TemplatePreview }) {
  const t = useT();
  const partes = preview.text.split(/(\{\{\w+\}\})/g);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {t(preview.onde)}
      </span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {partes.map((parte, i) =>
          /^\{\{\w+\}\}$/.test(parte) ? (
            <span
              key={i}
              className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary ring-1 ring-primary/20"
            >
              {parte.slice(2, -2)}
            </span>
          ) : (
            <span key={i} className="text-muted-foreground">
              {parte}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

export function TemplatesClient() {
  const t = useT();
  const { data, isPending } = useTemplates();
  const sync = useSyncTemplates();

  const waba = data?.data.waba ?? null;
  const templates = data?.data.templates ?? null;

  async function sincronizar() {
    const res = await sync.mutateAsync();
    const { inserted, updated, disabled } = res.data;
    toast.success(
      `${t("Sincronizado:")} ${inserted} ${t("novo(s),")} ${updated} ${t("atualizado(s),")} ${disabled} ${t("desativado(s).")}`,
    );
  }

  if (isPending || templates === null) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  // Estado vazio que ENSINA — distinguir "canal não conectado" de "conectado sem
  // template" é a diferença entre o operador saber o próximo passo ou não.
  if (!waba) {
    return (
      <Card className="p-6">
        <h2 className="font-medium">{t("Canal oficial não conectado")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Os templates vivem na sua conta do WhatsApp Business (Meta) — esta tela é um espelho deles. Conecte o canal oficial em")}{" "}
          <strong>{t("Conexões WhatsApp")}</strong> {t("para começar a sincronizar.")}
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="templates-root">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t("Espelho da conta")} <span className="font-mono text-xs">{waba}</span> ·{" "}
          {templates.length} {t("template(s)")}
        </p>
        <Button onClick={sincronizar} disabled={sync.isPending} data-testid="btn-sync">
          {sync.isPending ? t("Sincronizando…") : t("Sincronizar com a Meta")}
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">{t("Nenhum template ainda")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Crie templates no Gerenciador do WhatsApp e clique em")}{" "}
            <strong>{t("Sincronizar com a Meta")}</strong>.{" "}
            {t("Só templates aprovados podem ser enviados fora da janela de 24 horas.")}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((tpl) => (
            <Card key={`${tpl.name}:${tpl.language}`} className="p-4" data-testid="template-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tpl.name}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {tpl.language}
                </Badge>
                <Badge variant={statusTone(tpl.status)}>{tpl.status}</Badge>
                {tpl.category ? (
                  <Badge variant="outline" className="text-xs">
                    {tpl.category}
                  </Badge>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {tpl.slots.length === 0
                    ? t("sem parâmetros")
                    : `${tpl.slots.length} ${t("parâmetro(s)")}`}
                </span>
              </div>

              {tpl.rejectedReason ? (
                <p className="mt-2 text-sm text-destructive">
                  {t("Recusado:")} {tpl.rejectedReason}
                </p>
              ) : null}

              {tpl.previews.length > 0 || tpl.slots.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3 border-l-2 border-muted pl-3">
                  {tpl.previews.map((p, i) => (
                    <Preview key={`${p.onde}:${i}`} preview={p} />
                  ))}
                  {/* Slots SEM texto ao redor: header de mídia. É justamente o
                      parâmetro que contar `{{n}}` não enxerga. */}
                  {tpl.slots
                    .filter((s) => s.expects !== "text")
                    .map((s, i) => (
                      <div key={`m:${s.onde}:${i}`} className="flex flex-col gap-0.5">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {t(s.onde)} · {s.expects}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t("arquivo de")} {s.expects} {t("enviado no disparo")}
                        </span>
                      </div>
                    ))}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
