"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDaCaptura } from "@/lib/plataformas-de-anuncio/landing-config";

const subscribe = () => () => {};
const clientOrigin = () => window.location.origin;
const serverOrigin = () => "";
const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ScriptDoSite({
  slug,
  google,
  meta,
  idioma,
}: {
  slug: string;
  google: EstadoDaCaptura | null;
  meta: EstadoDaCaptura | null;
  idioma: Idioma;
}) {
  const t = (text: string) => traduzir(text, idioma);
  const origin = useSyncExternalStore(subscribe, clientOrigin, serverOrigin);
  const configs = [
    ["google", google],
    ["meta", meta],
  ] as const;
  const attributes = configs
    .filter(([, config]) => config?.habilitada)
    .map(
      ([platform, config]) =>
        `data-${platform}-whatsapp="${escapeAttribute(config!.whatsappE164.replace(/\D/g, ""))}"`,
    );
  const snippet =
    origin && attributes.length
      ? `<script defer src="${escapeAttribute(origin)}/rastreio/v1.js" data-org="${escapeAttribute(slug)}" ${attributes.join(" ")} referrerpolicy="no-referrer"></script>`
      : "";
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4" data-testid="script-do-site">
      <h2 className="text-lg font-semibold">{t("Script para instalar no site")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Salve e ligue a captura do Google ou do site. Depois, copie este script uma única vez para todas as páginas do seu site, antes de fechar o head. Se trocar os números configurados, copie o script novamente.",
        )}
      </p>
      {snippet ? (
        <>
          <code className="block overflow-x-auto rounded-md bg-muted/50 p-2 text-xs break-all">
            {snippet}
          </code>
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              if (await copyToClipboard(snippet)) toast.success(t("Script copiado."));
              else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
            }}
          >
            {t("Copiar script do site")}
          </Button>
        </>
      ) : (
        <p className="text-sm">
          {t("O script aparece depois que uma captura ativa estiver salva.")}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t(
          "Mantenha os links normais de WhatsApp nos botões. O script ajusta apenas os links dos números configurados, inclusive os adicionados depois. Sem origem reconhecida, o link original permanece.",
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          "A origem fica na mesma aba e no mesmo domínio durante a navegação. Uma nova campanha substitui a anterior. Ao clicar, o CRM gera o código na mensagem; ele precisa ser enviado pelo visitante. A mensagem usada é a que você salvou na captura.",
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          'Para não guardar a origem na aba, adicione data-storage="none" ao script. Para excluir um link, adicione data-rastreio-ignorar nele. Botões controlados apenas por JavaScript e links abreviados precisam de adaptação no site.',
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          "Teste abrindo o site com os parâmetros de uma campanha, navegando para outra página e clicando no WhatsApp. Confira o código na mensagem e a origem no contato. UTMs identificam a campanha no CRM; não garantem atribuição de conversão pela Meta.",
        )}
      </p>
    </section>
  );
}
