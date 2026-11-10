"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useUpdateWebhookSource, type WebhookSourceRow } from "@/hooks/webhooks/useWebhookSources";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy } from "@/lib/ui/icons";

/** O que a tela sabe da fonte depois do último PATCH; o id evita pintar outra fonte. */
interface EstadoDaMeta {
  id: string;
  paginaId: string | null;
  temToken: boolean;
  buscaLigada: boolean;
}

/**
 * A porta dos formulários de anúncio da Meta, dentro da fonte (issue #3768, doc 300).
 *
 * Três campos: a página, o token da página e a chave que liga a busca das
 * respostas. Tudo é de quem ADMINISTRA (o PATCH cobra `admin`); os demais papéis
 * veem o estado e não mexem. O token vai de ida e nunca volta — a tela só sabe
 * que ele existe, como já é com o segredo da assinatura.
 */
export function LeadAdsDaMeta({ source }: { source: WebhookSourceRow }) {
  const t = useT();
  const update = useUpdateWebhookSource();
  const podeAdministrar = usePermission("settings.write");
  const [salvo, setSalvo] = React.useState<EstadoDaMeta | null>(null);
  const estado: EstadoDaMeta =
    salvo?.id === source.id
      ? salvo
      : {
          id: source.id,
          paginaId: source.meta_page_id ?? null,
          temToken: Boolean(source.has_meta_page_token),
          buscaLigada: Boolean(source.meta_lead_retrieval),
        };
  const [pagina, setPagina] = React.useState(estado.paginaId ?? "");
  const [token, setToken] = React.useState("");
  const idDoRascunho = React.useRef(source.id);
  React.useEffect(() => {
    if (idDoRascunho.current === source.id) return;
    idDoRascunho.current = source.id;
    setPagina(source.meta_page_id ?? "");
    setToken("");
  }, [source.id, source.meta_page_id]);

  const base = typeof window !== "undefined" ? window.location.origin : "";
  const endereco = `${base}/api/v1/webhooks/meta-lead-ads/${source.path_token}`;

  const aplicar = (
    corpo: { meta_page_id?: string | null; meta_page_token?: string | null; meta_lead_retrieval?: boolean },
    aviso: string,
  ) =>
    update.mutate(
      { id: source.id, ...corpo },
      {
        onSuccess: (res) => {
          setSalvo({
            id: source.id,
            paginaId: res.data.meta_page_id ?? null,
            temToken: Boolean(res.data.has_meta_page_token),
            buscaLigada: Boolean(res.data.meta_lead_retrieval),
          });
          setPagina(res.data.meta_page_id ?? "");
          setToken("");
          toast.success(aviso);
        },
      },
    );

  const paginaDigitada = pagina.trim();
  const tokenDigitado = token.trim();
  const mudouPagina = paginaDigitada !== (estado.paginaId ?? "");

  return (
    <section className="space-y-3 rounded-sm border border-border p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t("Formulários de anúncio da Meta")}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            "Os leads dos formulários de anúncio do Facebook e do Instagram entram neste funil. No painel de desenvolvedor da Meta, cadastre o endereço abaixo como destino dos avisos da Página (campo leadgen) e depois cole aqui o token da página.",
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          {endereco}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={t("Copiar endereço para a Meta")}
          onClick={async () => {
            if (await copyToClipboard(endereco)) toast.success(t("Endereço copiado."));
            else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
          }}
        >
          <Copy />
        </Button>
      </div>

      {podeAdministrar ? (
        <>
          <div className="space-y-1">
            <label htmlFor="meta-page-id" className="block text-sm text-text">
              {t("Página do Facebook (id)")}
            </label>
            <Input
              id="meta-page-id"
              inputMode="numeric"
              value={pagina}
              placeholder={t("Em branco: usamos a página do token")}
              onChange={(e) => setPagina(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="meta-page-token" className="block text-sm text-text">
              {t("Token da página")}
            </label>
            <Input
              id="meta-page-token"
              type="password"
              autoComplete="off"
              value={token}
              placeholder={
                estado.temToken ? t("Token guardado. Cole outro só para trocar.") : t("Cole o token da página")
              }
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={update.isPending || (!tokenDigitado && !mudouPagina)}
              onClick={() =>
                aplicar(
                  {
                    meta_page_id: paginaDigitada || null,
                    ...(tokenDigitado ? { meta_page_token: tokenDigitado } : {}),
                  },
                  t("Página e token salvos."),
                )
              }
            >
              {t("Salvar página e token")}
            </Button>
            {estado.temToken ? (
              <Button
                type="button"
                variant="secondary"
                disabled={update.isPending}
                onClick={() =>
                  aplicar(
                    { meta_page_token: null, meta_page_id: null, meta_lead_retrieval: false },
                    t("Token removido."),
                  )
                }
              >
                {t("Remover token")}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {estado.paginaId
            ? `${t("Página ligada:")} ${estado.paginaId}`
            : t("Só quem administra a organização liga esta opção.")}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="meta-lead-retrieval" className="block text-sm font-medium text-text">
          {t("Buscar as respostas na Meta")}
        </label>
        <Switch
          id="meta-lead-retrieval"
          checked={estado.buscaLigada}
          disabled={!podeAdministrar || update.isPending || (!estado.temToken && !estado.buscaLigada)}
          onCheckedChange={(ligada) =>
            aplicar(
              { meta_lead_retrieval: ligada },
              ligada ? t("Busca das respostas ligada.") : t("Busca das respostas desligada."),
            )
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Desligada, o padrão. O aviso da Meta chega sem as respostas; ligada, buscamos nome, telefone, e-mail e as demais respostas com o token da página. Com a fonte ativa, lead que a Meta avisar e não entrar aparece em Leads recebidos, com o motivo; com a fonte pausada, a Meta recebe recusa e o aviso não é lido.",
        )}
      </p>
    </section>
  );
}
