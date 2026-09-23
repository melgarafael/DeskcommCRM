"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { fonteDeTemplates, rotaDeTemplates } from "@/lib/channels/templates-fonte";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";

/**
 * A janela fechou — e aqui está o caminho de volta.
 *
 * ─── Por que barrar sem oferecer saída não serve ────────────────────────────
 *
 * O commit anterior barrou o texto livre fora das 24h, que era o pedido. Só que
 * barrar sem oferecer o modelo deixa o operador SEM caminho: ele vê "só modelo
 * aprovado sai daqui" e não tem como mandar um. A plataforma do parceiro faz
 * exatamente isto na mesma situação — barra o texto e abre o seletor.
 *
 * ─── Só as APROVADAS ────────────────────────────────────────────────────────
 *
 * Listar uma em revisão ou reprovada seria oferecer um caminho que falha no
 * clique. Quem quiser criar ou acompanhar revisão tem a tela de Conexões; aqui
 * o único objetivo é reabrir a conversa agora.
 *
 * ─── Os valores do modelo ───────────────────────────────────────────────────
 *
 * Um campo por slot, aqui mesmo. A versão anterior oferecia o modelo e mandava
 * os valores VAZIOS: a rota recusava com `template_missing_values`, gravava a
 * linha como `failed` e devolvia 200 — e o `onSuccess`, que olhava só o código
 * HTTP, mostrava "Modelo enviado". Em 21/09/2026 um modelo com cabeçalho de
 * imagem saiu assim, e o operador ficou acreditando que tinha falado com o
 * cliente. Fora da janela este é o único caminho que ele tem; mentir aqui custa
 * o lead inteiro.
 *
 * Os slots vêm da rota, derivados da definição aprovada — nunca redigitados
 * deste lado. A chave de cada valor é a `valueKey` que a rota calcula com
 * `slotKey`, a MESMA função que monta o payload de envio: cabeçalho de mídia e
 * `{{1}}` do corpo têm a mesma `key` e só o endereço os separa.
 *
 * ─── O link salvo no modelo ─────────────────────────────────────────────────
 *
 * Link de mídia vale para TODO disparo do modelo, então colar a mesma URL a
 * cada janela fechada era trabalho repetido e chance de erro. O campo vem
 * pré-preenchido com o que foi salvo, e "Salvar este link no modelo" grava o
 * que está no campo — DEPOIS que o envio sai, para um link que a plataforma
 * recusou não virar o padrão. Só aparece quando a fonte das definições devolve
 * `savedValues`; fonte que não guarda nada não oferece a caixa.
 */
/** Um valor que o modelo exige no envio. Espelha `TemplateView['slots'][n]`. */
interface Slot {
  /** `'1'`, `'2'` ou nomeada — o que o operador vê no `{{…}}` do texto. */
  key: string;
  /** `image` | `video` | `document` | `text` | `url_suffix` | `coupon_code`. */
  expects: string;
  /** Rótulo humano do endereço: "cabeçalho", "corpo", "botão 1 (url)". */
  onde: string;
  /** A chave deste valor em `template_values`. Ver o cabeçalho do arquivo. */
  valueKey: string;
}

/** Rótulo do campo: diz ONDE o valor entra e O QUE ele é. */
function rotuloDoSlot(slot: Slot, t: (s: string) => string): string {
  const oQue =
    slot.expects === "image"
      ? t("link da imagem")
      : slot.expects === "video"
        ? t("link do vídeo")
        : slot.expects === "document"
          ? t("link do documento")
          : slot.expects === "url_suffix"
            ? t("sufixo da URL")
            : slot.expects === "coupon_code"
              ? t("código do cupom")
              : `{{${slot.key}}}`;
  return `${slot.onde} — ${oQue}`;
}

/** Mídia entra por URL pública: a Meta baixa o arquivo do link que mandamos. */
function ehMidia(slot: Slot): boolean {
  return slot.expects === "image" || slot.expects === "video" || slot.expects === "document";
}

interface ModeloAprovado {
  name: string;
  language: string;
  status: string;
  slots?: Slot[];
  /** A definição aprovada. É de onde sai o texto que vai no `body` do envio. */
  components?: unknown[];
  /** Links salvos no modelo, na chave de `template_values`. Ausente = fonte não guarda. */
  savedValues?: Record<string, string>;
}

/**
 * O texto da definição aprovada, que vai no `body` do envio.
 *
 * Cai para o nome do modelo quando a definição não trouxer corpo: um `body`
 * vazio reprovaria no mesmo schema que este conserto existe para satisfazer, e
 * a conversa mostraria uma bolha em branco. O nome é pior que o texto e melhor
 * que nada — e só acontece em definição sem BODY, que a plataforma não aprova.
 */
function textoDoModelo(modelo: ModeloAprovado): string {
  return lerConteudo(modelo.components ?? []).body?.trim() || modelo.name;
}

export function JanelaFechadaAviso({
  conversationId,
  provider,
  motivo,
}: {
  conversationId: string;
  /** Decide de ONDE vêm as definições. A tela não interpreta este valor. */
  provider: string | null;
  motivo: string;
}) {
  const t = useT();
  const send = useSendMessage();
  const [escolhido, setEscolhido] = useState("");
  const [valores, setValores] = useState<Record<string, string>>({});
  /** Chaves cujo valor o operador pediu para salvar no modelo. */
  const [salvar, setSalvar] = useState<Record<string, boolean>>({});
  const qc = useQueryClient();

  const fonte = fonteDeTemplates(provider);
  const { data } = useQuery({
    // A chave inclui a fonte: sem isso, trocar de conversa entre canais serviria
    // a lista em cache do canal anterior, e o operador mandaria um modelo que
    // não existe na conta desta conversa.
    queryKey: ["templates-da-conversa", fonte],
    enabled: fonte !== null,
    queryFn: async () =>
      apiClient.get<{ data: { templates: ModeloAprovado[] } }>(rotaDeTemplates(fonte!)),
    staleTime: 30_000,
  });

  const aprovados = useMemo(
    () => (data?.data.templates ?? []).filter((tpl) => tpl.status?.toUpperCase() === "APPROVED"),
    [data],
  );

  const atual = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === escolhido) ?? null;
  const slots = atual?.slots ?? [];
  // O botão espera o formulário inteiro. A mesma checagem que `missingSlots`
  // faz no servidor, feita antes do clique: recusar depois de enviar é a
  // experiência que este conserto existe para acabar.
  const faltando = slots.filter((s) => !(valores[s.valueKey] ?? "").trim());

  /** Trocar de modelo zera os valores (chave de um não vale para o outro) e traz os salvos. */
  function escolher(valor: string) {
    setEscolhido(valor);
    const modelo = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === valor);
    setValores({ ...(modelo?.savedValues ?? {}) });
    setSalvar({});
  }

  /** Grava no modelo os links marcados. Falhar aqui não desfaz o envio, só avisa. */
  function salvarNoModelo(modelo: ModeloAprovado, enviados: Record<string, string>) {
    const aSalvar = Object.fromEntries(
      Object.keys(salvar)
        .filter((chave) => salvar[chave])
        .map((chave) => [chave, enviados[chave] ?? ""]),
    );
    if (Object.keys(aSalvar).length === 0) return;
    apiClient
      .patch(rotaDeTemplates(fonte!), {
        name: modelo.name,
        language: modelo.language,
        values: aSalvar,
      })
      .then(() => qc.invalidateQueries({ queryKey: ["templates-da-conversa", fonte] }))
      .catch(() => toast.error(t("O modelo saiu, mas não consegui salvar o link nele.")));
  }

  function enviar() {
    if (!atual) return;
    const modelo = atual;
    const enviados = valores;
    send.mutate(
      {
        conversation_id: conversationId,
        type: "template",
        template_name: atual.name,
        template_language: atual.language,
        // ─── O `body` NÃO é decorativo: sem ele o envio nem sai ──────────────
        //
        // `sendMessageSchema` exige `body`, `media_url` ou `media_storage_path`.
        // A primeira versão desta tela mandava só o nome do modelo, e o pedido
        // morria em 422 ANTES de tocar o transporte — o seletor aparecia, o
        // operador escolhia, e nada acontecia. Com a janela fechada esta é a
        // única saída que ele tem, então o botão que não envia é o pior lugar
        // possível para um defeito silencioso.
        //
        // O texto renderizado é também o que a conversa mostra depois: é o
        // mesmo caminho que o agente já usa quando manda modelo.
        body: textoDoModelo(atual),
        template_values: valores,
      },
      {
        // ─── 2xx NÃO é "saiu" ────────────────────────────────────────────────
        //
        // A rota grava a linha ANTES de tentar o transporte e, quando o envio
        // falha, atualiza a MESMA linha para `failed` e devolve 200 com ela.
        // Um `onSuccess` que só olha o código HTTP celebra o que não saiu: em
        // 2026-09-21 um modelo com cabeçalho de imagem virou
        // `template_missing_values: 1`, e o operador leu "Modelo enviado" com
        // nada no aparelho do cliente. Com a janela fechada este é o único
        // caminho que ele tem — mentir aqui custa o lead inteiro.
        onSuccess: (res) => {
          const enviada = res.data;
          if (enviada?.status === "failed") {
            toast.error(enviada.error_message ?? t("Não consegui enviar o modelo."));
            return;
          }
          salvarNoModelo(modelo, enviados);
          setEscolhido("");
          setValores({});
          setSalvar({});
          toast.success(t("Modelo enviado — a janela reabre quando o cliente responder."));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("Não consegui enviar o modelo.")),
      },
    );
  }

  if (!fonte) return <p role="status" className="border-t px-4 py-3 text-sm text-muted-foreground">{motivo}</p>;

  return (
    <div className="border-t border-amber-300 bg-amber-50/60 px-4 py-3 dark:border-amber-800/60 dark:bg-amber-950/30">
      <p className="mb-2 text-xs text-amber-900 dark:text-amber-200">{motivo}</p>

      {aprovados.length === 0 ? (
        // Sem modelo aprovado não há saída por aqui, e dizer isso é melhor que
        // um seletor vazio que se lê como "ainda não carregou".
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          {t("Nenhum modelo aprovado ainda. Crie um em")} <strong>{t("Conexões → Templates")}</strong>{" "}
          {t("e envie quando a plataforma aprovar.")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={escolhido}
            onChange={(e) => escolher(e.target.value)}
            disabled={send.isPending}
            aria-label={t("Modelo aprovado")}
            className={cn(
              "h-9 min-w-[16rem] flex-1 rounded-md border border-input bg-background px-2 text-sm",
              "focus:outline-hidden focus:ring-1 focus:ring-ring",
            )}
          >
            <option value="">{t("Escolha um modelo aprovado…")}</option>
            {aprovados.map((tpl) => (
              <option key={`${tpl.name}|${tpl.language}`} value={`${tpl.name}|${tpl.language}`}>
                {tpl.name} ({tpl.language})
                {(tpl.slots?.length ?? 0) > 0 ? ` · ${tpl.slots!.length} ${t("parâmetro(s)")}` : ""}
              </option>
            ))}
          </select>
          {/* Desabilitado enquanto faltar valor: é a mesma conta que o servidor
              refaz em `missingSlots`, adiantada para antes do clique. */}
          <Button
            type="button"
            size="sm"
            onClick={enviar}
            disabled={!atual || faltando.length > 0 || send.isPending}
          >
            {send.isPending ? t("Enviando…") : t("Enviar modelo")}
          </Button>
        </div>
      )}

      {slots.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {slots.map((slot) => (
            <label key={slot.valueKey} className="flex flex-col gap-1">
              <span className="text-[11px] text-amber-900/80 dark:text-amber-200/80">
                {rotuloDoSlot(slot, t)}
              </span>
              <input
                type={ehMidia(slot) ? "url" : "text"}
                value={valores[slot.valueKey] ?? ""}
                onChange={(e) =>
                  setValores((v) => ({ ...v, [slot.valueKey]: e.target.value }))
                }
                disabled={send.isPending}
                placeholder={ehMidia(slot) ? "https://…" : ""}
                className={cn(
                  "h-9 rounded-md border border-input bg-background px-2 text-sm",
                  "focus:outline-hidden focus:ring-1 focus:ring-ring",
                )}
              />
              {ehMidia(slot) && atual?.savedValues !== undefined && (
                <span className="flex items-center gap-1.5 text-[11px] text-amber-900/80 dark:text-amber-200/80">
                  <input
                    type="checkbox"
                    checked={salvar[slot.valueKey] ?? false}
                    onChange={(e) =>
                      setSalvar((v) => ({ ...v, [slot.valueKey]: e.target.checked }))
                    }
                    disabled={send.isPending}
                    aria-label={t("Salvar este link no modelo")}
                  />
                  {t("Salvar este link no modelo")}
                  {atual.savedValues[slot.valueKey] ? ` · ${t("já há um link salvo")}` : ""}
                </span>
              )}
            </label>
          ))}
          {/* Por que pedir o link se a imagem já está no modelo: o que a Meta
              guarda na aprovação é só a AMOSTRA. No disparo ela exige o
              parâmetro de novo, sempre — sem ele vem `132012 Format mismatch,
              expected IMAGE, received UNKNOWN`. */}
          {slots.some(ehMidia) && (
            <p className="text-[11px] text-amber-900/70 dark:text-amber-200/70">
              {t("A mídia do modelo entra por link público — a plataforma baixa o arquivo na hora do envio.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
