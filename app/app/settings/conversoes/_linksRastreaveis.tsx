"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { salvarLinkRastreavel } from "@/app/actions/settings/linksRastreaveis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyToClipboard } from "@/lib/clipboard";
import { randomId } from "@/lib/random-id";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  mensagemComRef,
  SUFIXO_GOOGLE,
  type LinkInput,
  type LinkRastreavel,
  type MetricasLink,
} from "@/lib/plataformas-de-anuncio/rastreio/contrato";

const subscribe = () => () => {};
const initial: LinkInput = {
  name: "",
  whatsapp_e164: "",
  message_template: "Olá! Gostaria de saber mais.",
  use_case: "site",
  utm: {},
  enabled: true,
};
const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function LinksRastreaveis({
  links,
  metricas,
  idioma,
}: {
  links: LinkRastreavel[];
  metricas: MetricasLink[] | null;
  idioma: Idioma;
}) {
  const t = (v: string) => traduzir(v, idioma);
  const telefoneExemplo = useTelefoneExemplo();
  const router = useRouter();
  const [form, setForm] = useState<LinkInput>(initial);
  const [pending, start] = useTransition();
  const [site, setSite] = useState("");
  const [verification, setVerification] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const origin = useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => "",
  );
  const saved = links.find((l) => l.id === form.id);
  const url = saved && origin ? `${origin}/api/v1/rastreio/${saved.id}` : "";
  const snippet =
    saved && origin
      ? `<script defer src="${escapeAttr(origin)}/rastreio/v1.js" data-link-id="${saved.id}" data-whatsapp="${saved.whatsapp_e164.replace(/\D/g, "")}" referrerpolicy="no-referrer"></script>`
      : "";
  async function copy(value: string) {
    if (await copyToClipboard(value)) toast.success(t("Copiado."));
    else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
  }
  function verify() {
    cleanup.current?.();
    let target: URL;
    try {
      target = new URL(site);
      if (target.protocol !== "https:" || target.username || target.password) throw new Error();
    } catch {
      setVerification(t("Informe a URL HTTPS pública do seu site."));
      return;
    }
    if (!saved) return;
    const nonce = randomId();
    target.hash = new URLSearchParams({ "rastreio-verificar": nonce }).toString();
    const popup = window.open(target.href, "_blank");
    if (!popup) {
      setVerification(t("Permita a abertura da aba para verificar o site."));
      return;
    }
    const listener = (event: MessageEvent) => {
      if (
        event.source !== popup ||
        event.origin !== target.origin ||
        event.data?.type !== "rastreio:v1:instalado" ||
        event.data.nonce !== nonce ||
        event.data.linkId !== saved.id
      )
        return;
      cleanup.current?.();
      setVerification(
        event.data.buttons > 0
          ? t(
              "Script carregado e botão de WhatsApp reconhecido. Confira o código ao clicar no site.",
            )
          : t(
              "Script carregado, mas nenhum botão deste número foi encontrado na abertura da página.",
            ),
      );
    };
    window.addEventListener("message", listener);
    const timer = setTimeout(() => {
      cleanup.current?.();
      setVerification(
        t(
          "Não foi possível confirmar automaticamente. Confira o script, o domínio e os bloqueios do navegador; este resultado não prova que o script está ausente.",
        ),
      );
    }, 20_000);
    cleanup.current = () => {
      window.removeEventListener("message", listener);
      clearTimeout(timer);
    };
    setVerification(t("Verificando na aba aberta. Aguarde até 20 segundos."));
  }
  return (
    <section className="space-y-5" data-testid="links-rastreaveis">
      <div>
        <h2 className="text-lg font-semibold">{t("Links rastreáveis")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Crie um link por campanha ou botão. O código liga o clique à mensagem enviada pelo visitante.",
          )}
        </p>
      </div>
      {metricas === null && (
        <p role="alert">
          {t("As métricas estão indisponíveis. Atualize a página para tentar novamente.")}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {[t("Nome"), t("Cliques"), t("Contatos"), t("Negócios"), t("Estado"), t("Ação")].map(
                (h) => (
                  <th key={h} className="p-2 text-left">
                    {t(h)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {links.map((l) => {
              const m = metricas?.find((v) => v.link_id === l.id);
              return (
                <tr key={l.id} className="border-t">
                  <td className="p-2">{l.name}</td>
                  <td>{metricas ? (m?.clicks ?? 0) : "—"}</td>
                  <td>{metricas ? (m?.contacts ?? 0) : "—"}</td>
                  <td>{metricas ? (m?.leads ?? 0) : "—"}</td>
                  <td>{t(l.enabled ? "Ativo" : "Desativado")}</td>
                  <td>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setForm(l);
                        setVerification("");
                        cleanup.current?.();
                      }}
                    >
                      {t("Editar")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "As contagens usam os registros ainda retidos no CRM. Cliques incluem acessos repetidos; contatos e negócios são distintos por link. Não representam pessoas únicas nem o total histórico após o expurgo.",
        )}
      </p>
      <form
        className="max-w-2xl space-y-4 rounded-md border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            try {
              const result = await salvarLinkRastreavel(form);
              if (!result.ok) {
                toast.error(t(result.error));
                return;
              }
              setForm({ ...form, id: result.id });
              toast.success(t("Link salvo."));
              router.refresh();
            } catch {
              toast.error(
                t("Não foi possível salvar este link. Atualize a página e tente novamente."),
              );
            }
          });
        }}
      >
        <h3 className="font-medium">{t(form.id ? "Editar link" : "Novo link")}</h3>
        <div>
          <Label htmlFor="link-name">{t("Nome")}</Label>
          <Input
            id="link-name"
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="link-phone">{t("WhatsApp com código do país")}</Label>
          <Input
            id="link-phone"
            required
            placeholder={telefoneExemplo}
            pattern="\+[1-9][0-9]{7,14}"
            value={form.whatsapp_e164}
            onChange={(e) => setForm({ ...form, whatsapp_e164: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="link-message">{t("Mensagem inicial")}</Label>
          <Input
            id="link-message"
            required
            maxLength={900}
            value={form.message_template}
            onChange={(e) => setForm({ ...form, message_template: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="link-use">{t("Onde será usado")}</Label>
          <select
            id="link-use"
            className="w-full rounded-md border bg-background p-2"
            value={form.use_case}
            onChange={(e) =>
              setForm({ ...form, use_case: e.target.value as LinkInput["use_case"] })
            }
          >
            <option value="site">{t("Site")}</option>
            <option value="anuncio">{t("Anúncio")}</option>
            <option value="organico">{t("Orgânico")}</option>
          </select>
        </div>
        {(
          [
            ["utm_source", t("Origem da campanha")],
            ["utm_medium", t("Meio da campanha")],
            ["utm_campaign", t("Nome da campanha")],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <Label htmlFor={key}>{label}</Label>
            <Input
              id={key}
              maxLength={200}
              value={form.utm[key] ?? ""}
              onChange={(e) => setForm({ ...form, utm: { ...form.utm, [key]: e.target.value } })}
            />
          </div>
        ))}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          {t("Link ativo")}
        </label>
        <p className="text-sm break-words">
          {t("Prévia da mensagem")}:{" "}
          {mensagemComRef(form.message_template).replace("{token}", "ABC234")}
        </p>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {t(pending ? "Salvando…" : "Salvar link")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setForm(initial);
              setVerification("");
              cleanup.current?.();
            }}
          >
            {t("Novo link")}
          </Button>
        </div>
      </form>
      {saved && (
        <div className="max-w-2xl space-y-4 rounded-md border p-4">
          {!saved.enabled && (
            <p role="alert">
              {t("Este link está desativado e não abre o WhatsApp. Ative e salve para usar.")}
            </p>
          )}
          <p className="text-sm">{t("Os códigos abaixo refletem a última configuração salva.")}</p>
          <code className="block break-all">{url}</code>
          <Button variant="outline" onClick={() => copy(url)}>
            {t("Copiar link")}
          </Button>
          <h3 className="font-medium">{t("Script para instalar no site")}</h3>
          <code className="block text-xs break-all">{snippet}</code>
          <Button variant="outline" onClick={() => copy(snippet)}>
            {t("Copiar script do site")}
          </Button>
          <p className="text-sm">
            {t(
              "Instale uma vez antes de fechar o head e mantenha o botão normal de WhatsApp. Use apenas um script por número. O visitante precisa enviar a mensagem com o código para a atribuição chegar ao CRM.",
            )}
          </p>
          <Label htmlFor="tracking-site">{t("URL do site")}</Label>
          <Input
            id="tracking-site"
            type="url"
            value={site}
            onChange={(e) => setSite(e.target.value)}
          />
          <Button variant="outline" onClick={verify}>
            {t("Verificar instalação")}
          </Button>
          <p role="status" className="text-sm">
            {verification}
          </p>
          <h3 className="font-medium">{t("Sufixo de URL final do Google Ads")}</h3>
          <code className="block text-xs break-all">{SUFIXO_GOOGLE}</code>
          <Button variant="outline" onClick={() => copy(SUFIXO_GOOGLE)}>
            {t("Copiar sufixo")}
          </Button>
          <p className="text-sm">
            {t(
              "Ative a codificação automática no Google Ads. O script preserva gclid, gbraid ou wbraid recebidos no site. UTMs sozinhas identificam a origem no CRM, mas não comprovam uma conversão no Google.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}
