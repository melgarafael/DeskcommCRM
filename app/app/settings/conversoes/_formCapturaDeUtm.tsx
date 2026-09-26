"use client";

/**
 * O formulário do ENDEREÇO DE CAPTURA — a fatia que faz o ref valer para quem
 * não escreve código.
 *
 * O que esta tela entrega é uma URL: a pessoa cola no botão de WhatsApp da
 * landing page, no lugar do `wa.me`, e o CRM passa a guardar as UTMs do clique
 * e a mandar o ref curto dentro do texto da mensagem
 * (`app/api/v1/anuncios/meta/[org]/route.ts`).
 *
 * Irmão dos dois formulários acima, e com o mesmo gate (admin + MFA na action).
 */

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateCapturaDeUtm } from "@/app/actions/settings/updateCapturaDeUtm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { copyToClipboard } from "@/lib/clipboard";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDaCaptura } from "@/lib/plataformas-de-anuncio/landing-config";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar este endereço.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

const TEXTO_PADRAO = "Olá! Vim pelo site. [ref:{token}]";

/**
 * As macros de URL da plataforma, no exemplo que a tela manda copiar.
 *
 * Elas NÃO são traduzidas nem geradas: são o vocabulário da plataforma de
 * anúncio, e escrevê-las em espanhol faria a URL parar de funcionar em
 * silêncio.
 */
const EXEMPLO_DE_PARAMETROS =
  "utm_source=meta&utm_campaign={{campaign.name}}&utm_adset={{adset.name}}&utm_ad={{ad.name}}&utm_placement={{placement}}";

/**
 * A origem da página vence a variável de build: a `NEXT_PUBLIC_APP_URL` é
 * embutida no build e, num self-host em Docker, fica congelada no marcador do
 * Dockerfile — a URL colada na landing page apontaria para o lugar errado.
 * Mesma lição de `app/app/webhooks/_components/SourceDetail.tsx`.
 */
const assinarOrigem = () => () => {};
const origemDoNavegador = () => window.location.origin;
const origemNoServidor = () => "";

function enderecoDeCaptura(slug: string, plataforma: "meta" | "google", origem: string): string {
  return `${origem}/api/v1/anuncios/${plataforma}/${encodeURIComponent(slug)}`;
}

export function FormularioDeCapturaDeUtm({
  estado,
  idioma,
  slug,
  numerosConectados,
  plataforma = "meta",
}: {
  plataforma?: "meta" | "google";
  estado: EstadoDaCaptura | null;
  idioma: Idioma;
  /** O apelido da organização na URL — é o `[org]` da rota pública. */
  slug: string;
  /** Os números que o CRM já conhece, para não obrigar a digitar. */
  numerosConectados: string[];
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [numero, setNumero] = useState(estado?.whatsappE164 ?? numerosConectados[0] ?? "");
  const [texto, setTexto] = useState(estado?.messageTemplate ?? TEXTO_PADRAO);
  const [habilitada, setHabilitada] = useState(estado?.habilitada ?? true);

  const origem = useSyncExternalStore(assinarOrigem, origemDoNavegador, origemNoServidor);
  const urlParaColar = `${enderecoDeCaptura(slug, plataforma, origem)}${plataforma === "meta" ? `?${EXEMPLO_DE_PARAMETROS}` : ""}`;
  const podeSalvar = numero.trim().length >= 8 && texto.includes("{token}");

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateCapturaDeUtm({
        plataforma: plataforma === "google" ? "google_ads" : "meta_ads",
        whatsapp_e164: numero,
        message_template: texto,
        enabled: habilitada,
      });

      if (resultado.ok) {
        toast.success(t("Endereço de captura salvo."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  async function copiar() {
    const copiou = await copyToClipboard(urlParaColar);
    if (copiou) toast.success(t("Endereço copiado."));
    else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
  }

  return (
    <Card className="p-6" data-testid={`captura-${plataforma}`}>
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            {t(
              plataforma === "google"
                ? "Captura de origem do Google Ads"
                : "Endereço de captura (sem script na página)",
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(
              "Em vez do link do WhatsApp, o botão da sua página aponta para este endereço. Ele guarda a origem, cria um código curto e abre o WhatsApp com esse código no texto — o visitante não vê nada além do botão de sempre.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${plataforma}_captura_numero`}>{t("Para qual WhatsApp mandar")}</Label>
          <Input
            id={`${plataforma}_captura_numero`}
            list={`${plataforma}_captura_numeros_conectados`}
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            placeholder="+5511999999999"
          />
          {/* Os números conectados entram como SUGESTÃO, não como lista fechada:
              o número da landing page não precisa ser um canal do CRM. */}
          <datalist id={`${plataforma}_captura_numeros_conectados`}>
            {numerosConectados.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">
            {t(
              "Formato internacional, com o código do país. Os números já conectados aparecem como sugestão.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${plataforma}_captura_texto`}>
            {t("Texto que a pessoa vai enviar")}
          </Label>
          <Input
            id={`${plataforma}_captura_texto`}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={TEXTO_PADRAO}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Precisa conter o campo do código — é onde o código curto entra antes de abrir o WhatsApp.",
            )}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-md border p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${plataforma}_captura_habilitada`}>
              {t("Endereço de captura ligado")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "Desligar faz o endereço parar de responder. Quem já usa o link do WhatsApp direto não é afetado.",
              )}
            </p>
          </div>
          <Switch
            id={`${plataforma}_captura_habilitada`}
            checked={habilitada}
            onCheckedChange={setHabilitada}
          />
        </div>

        <div className="rounded-md border p-4">
          <p className="text-sm font-medium">{t("Cole este endereço no botão da sua página")}</p>
          {plataforma === "google" && (
            <p className="mt-2 text-sm">
              {t(
                "O botão do site precisa repassar gclid, gbraid ou wbraid recebidos na página. Um endereço fixo sem esses parâmetros não identifica o clique. Mantenha o código na mensagem enviada ao WhatsApp.",
              )}
            </p>
          )}
          <code className="mt-2 block overflow-x-auto rounded-md bg-muted/50 p-2 text-xs break-all">
            {urlParaColar}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              "Os campos entre chaves são preenchidos pela própria plataforma de anúncio quando você os põe nos parâmetros de URL do anúncio. Se a sua página serve mais de uma campanha, o botão precisa repassar os parâmetros que a página recebeu — sem isso a conversa entra sem origem.",
            )}
          </p>
          <Button type="button" variant="outline" className="mt-3" onClick={copiar}>
            {t("Copiar endereço")}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar endereço de captura")}
          </Button>
          {!podeSalvar && (
            <span className="text-xs text-muted-foreground">
              {t("Informe o número e mantenha o campo do código no texto para poder salvar.")}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
