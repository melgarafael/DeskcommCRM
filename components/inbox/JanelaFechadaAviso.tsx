"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";

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
 * ─── O que este componente NÃO faz ──────────────────────────────────────────
 *
 * Não preenche `{{1}}`, `{{2}}`. Modelo com parâmetro é oferecido, mas o envio
 * vai com os valores vazios — e a plataforma recusa. Preencher direito exige a
 * tela de variáveis (que existe em Conexões) trazida para cá, com preview por
 * modelo. Por isso o seletor MARCA quais pedem parâmetro, em vez de escondê-los
 * (esconder faria o operador procurar um modelo que existe e não aparece).
 */
interface ModeloAprovado {
  name: string;
  language: string;
  status: string;
  slots?: unknown[];
  /** A definição aprovada. É de onde sai o texto que vai no `body` do envio. */
  components?: unknown[];
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
  const pedeParametros = (atual?.slots?.length ?? 0) > 0;

  function enviar() {
    if (!atual) return;
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
      },
      {
        onSuccess: () => {
          setEscolhido("");
          toast.success(t("Modelo enviado — a janela reabre quando o cliente responder."));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("Não consegui enviar o modelo.")),
      },
    );
  }

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
            onChange={(e) => setEscolhido(e.target.value)}
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
          <Button type="button" size="sm" onClick={enviar} disabled={!atual || send.isPending}>
            {send.isPending ? t("Enviando…") : t("Enviar modelo")}
          </Button>
        </div>
      )}

      {pedeParametros && (
        // Avisa ANTES do clique: este modelo precisa de valores e este seletor
        // ainda não os coleta, então o envio vai falhar na plataforma.
        <p className="mt-2 text-[11px] text-amber-900/80 dark:text-amber-200/80">
          {t("Este modelo pede")} {atual?.slots?.length} {t("valor(es) e ainda não dá para preenchê-los aqui — envie por")}{" "}
          <strong>{t("Conexões → Templates")}</strong>, {t("ou escolha um modelo sem parâmetros.")}
        </p>
      )}
    </div>
  );
}
