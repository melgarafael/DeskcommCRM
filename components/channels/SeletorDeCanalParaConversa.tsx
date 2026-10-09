"use client";
/**
 * O seletor de canal de SAÍDA ao iniciar uma conversa nova (issue #2382).
 *
 * ─── O que ele responde, e o que ele NÃO faz ────────────────────────────────
 * Em uma org com mais de um número (o canal oficial e o servido por QR Code, o
 * número de Peças e o de Vendas, o do Centro Automotivo e o do Comercial), o
 * operador decide POR QUAL número a conversa nasce. A escolha vai para o corpo
 * de `POST /conversations/open-with-contact` como `channel_session_id` — a rota
 * já aceitava esse campo, então nada do lado do servidor muda: a conversa nasce
 * amarrada à sessão escolhida (`conversa` é o thread com aquele contato naquele
 * número, índice único por org, contato e sessão) e os envios seguintes resolvem
 * o canal pela própria conversa (`channelSessionId: c.channel_session_id`), que
 * é o critério "os envios posteriores continuam usando o mesmo canal".
 *
 * ─── Quando NÃO abre ────────────────────────────────────────────────────────
 * Um único canal elegível: segue direto, já com aquele canal gravado. Zero
 * elegíveis (só canal caído/desativado, ou a lista ainda não carregou): segue
 * direto sem escolha, e o servidor decide como sempre decidiu. Um seletor que
 * trava o atendimento piora o defeito que veio corrigir.
 *
 * ─── Quem decide o que aparece ──────────────────────────────────────────────
 * `candidatosParaConversaNova` / `elegiveisParaConversaNova`, em
 * `lib/channels/conversa-nova.ts`. Aqui só a intenção do operador: quem está
 * fora do ar aparece com o estado e desmarcado (com o POR QUÊ visível), quem
 * está desativado nem aparece.
 *
 * ─── Lista é assíncrona, e o erro não pode travar ───────────────────────────
 * `useChannelSessions` é a MESMA fonte do seletor do inbox e da Central de
 * Conexões (rota que já exclui arquivado, voz e traz `metadata.disabled`).
 * Se a consulta falhar ou ainda estiver carregando, `data` vem `undefined`, as
 * peneiras devolvem lista vazia e o fluxo segue direto — a alternativa seria
 * deixar o botão "Iniciar conversa" sem resposta por causa de um problema de
 * leitura que não impede abrir a conversa.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChannelSessions, type ChannelSession } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import {
  candidatosParaConversaNova,
  elegiveisParaConversaNova,
  rotuloDoTipoDeCanal,
} from "@/lib/channels/conversa-nova";
import { lerEstadoDoCanal, nomeDoCanal, rotuloDoEstadoDoCanal } from "@/lib/channels/estado";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

/** O que o POST precisa para abrir (ou reabrir) a conversa do contato. */
export interface AlvoDeConversa {
  contact_id?: string;
  phone_number?: string;
  name?: string;
}

/** Tom do badge de estado — mesma régua dos badges do produto. */
const TOM: Record<string, "success" | "warning" | "error" | "neutral"> = {
  success: "success",
  warning: "warning",
  error: "error",
  neutral: "neutral",
};

interface PropsDoSeletor {
  /** Quem APARECE — já filtrado por `candidatosParaConversaNova`. */
  candidatos: ChannelSession[];
  abrindo: boolean;
  aoEscolher: (channel_session_id: string) => void;
  aoCancelar: () => void;
}

/**
 * Uma opção por linha: nome amigável, número, tipo/provedor e estado — os
 * quatro que a issue #2382 pede ver "para cada opção".
 *
 * O `<label>` envolvendo o rádio é o que dá o nome acessível inteiro ("Peças
 * +5517999990000 Meta Cloud API Conectado") a quem usa leitor de tela; um
 * `aria-label` repetindo a frase seria a segunda fonte que diverge da primeira.
 */
function OpcaoDeCanal({
  canal,
  escolhido,
  elegivel,
  aoMudar,
}: {
  canal: ChannelSession;
  escolhido: boolean;
  elegivel: boolean;
  aoMudar: () => void;
}) {
  const t = useT();
  const nome = nomeDoCanal(canal, t);
  const numero = phoneForDisplay(canal.phone_number);
  const tipo = rotuloDoTipoDeCanal(canal.provider);
  const estado = lerEstadoDoCanal(canal.status);

  return (
    <label
      className={[
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        escolhido ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-muted/60",
        !elegivel ? "cursor-not-allowed opacity-60" : "",
      ].join(" ")}
    >
      <input
        type="radio"
        name="canal-para-conversa-nova"
        value={canal.id}
        checked={escolhido}
        disabled={!elegivel}
        onChange={aoMudar}
        className="mt-1 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{nome}</span>
        {numero && numero !== nome && (
          <span className="block text-sm text-muted-foreground">{numero}</span>
        )}
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {tipo && <span className="text-xs text-muted-foreground">{tipo}</span>}
          <Badge variant={TOM[estado.tom] ?? "neutral"} className="text-[11px] font-normal">
            {rotuloDoEstadoDoCanal(canal.status, t)}
          </Badge>
        </span>
      </span>
    </label>
  );
}

/**
 * O diálogo. Só é montado quando há escolha pendente, então a seleção nasce
 * preenchida com o primeiro canal elegível — "cancelar" não tem como deixar o
 * fluxo sem destino.
 */
export function SeletorDeCanalParaConversa({
  candidatos,
  abrindo,
  aoEscolher,
  aoCancelar,
}: PropsDoSeletor) {
  const t = useT();
  const elegiveis = elegiveisParaConversaNova(candidatos);
  const [marcado, setMarcado] = useState<string | null>(null);

  // O marcado só vale se ainda for um canal elegível: a lista é assíncrona e
  // pode mudar (canal caiu) enquanto o diálogo está aberto.
  const ativo =
    marcado && elegiveis.some((c) => c.id === marcado) ? marcado : (elegiveis[0]?.id ?? null);

  return (
    <Dialog open onOpenChange={(aberto) => { if (!aberto) aoCancelar(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Escolha o canal para iniciar a conversa")}</DialogTitle>
          <DialogDescription>
            {t("A conversa fica vinculada ao canal escolhido, e as próximas mensagens saem por ele.")}
          </DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("Canais disponíveis")} className="space-y-2">
          {candidatos.map((canal) => (
            <OpcaoDeCanal
              key={canal.id}
              canal={canal}
              escolhido={ativo === canal.id}
              elegivel={elegiveis.some((e) => e.id === canal.id)}
              aoMudar={() => setMarcado(canal.id)}
            />
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={aoCancelar} disabled={abrindo}>
            {t("Cancelar")}
          </Button>
          <Button
            onClick={() => { if (ativo) aoEscolher(ativo); }}
            disabled={!ativo || abrindo}
            aria-busy={abrindo}
          >
            {abrindo ? t("Abrindo…") : t("Iniciar conversa")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * O fluxo completo: decidir se há escolha, abrir a conversa pelo canal certo e
 * devolver o diálogo pronto para renderizar.
 *
 * `aoAbrir` é de quem chama porque o que acontece DEPOIS muda por tela — a
 * tabela de contatos invalida `["contacts"]` e navega; o card do funil
 * invalida `["board"]`. O POST, o erro e a escolha do canal são os mesmos.
 */
export function useConversaNovaComEscolhaDeCanal(opts: {
  aoAbrir: (conversationId: string) => Promise<void> | void;
}) {
  const t = useT();
  const canais = useChannelSessions();
  const [pendente, setPendente] = useState<AlvoDeConversa | null>(null);
  const [abrindo, setAbrindo] = useState(false);

  const candidatos = candidatosParaConversaNova(canais.data);

  /**
   * A lista, garantida na hora de DECIDIR.
   *
   * Na primeira visita a consulta ainda pode estar carregando; clicar nesse
   * intervalo abriria a conversa sem perguntar — o defeito que a issue veio
   * corrigir, disparado pela corrida mais comum de todas. Então espera-se a
   * leitura uma vez. Se ela falhar, volta `undefined` e o fluxo segue sem
   * escolha, como sempre seguiu: uma leitura ruim não pode travar o
   * atendimento.
   */
  async function listaDeCanais(): Promise<ChannelSession[] | undefined> {
    if (canais.data) return canais.data;
    if (canais.isError) return undefined;
    return canais.refetch();
  }

  /** Faz o POST. Não mexe em `abrindo` — quem decide quando abrir manda nele. */
  async function executar(alvo: AlvoDeConversa, channelSessionId?: string) {
    try {
      const res = await fetch("/api/v1/conversations/open-with-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...alvo,
          ...(channelSessionId ? { channel_session_id: channelSessionId } : {}),
        }),
      });
      const json = (await res.json()) as {
        data?: { conversation_id: string };
        error?: { message?: string };
      };
      if (!res.ok || !json.data?.conversation_id) {
        throw new Error(json.error?.message ?? t("Não foi possível abrir a conversa."));
      }
      await opts.aoAbrir(json.data.conversation_id);
    } catch (err) {
      toast.error(err instanceof Error ? t(err.message) : t("Não foi possível abrir a conversa."));
    }
  }

  async function iniciarConversa(alvo: AlvoDeConversa) {
    if (abrindo) return;
    setAbrindo(true);
    try {
      const lista = await listaDeCanais();
      const elegiveis = elegiveisParaConversaNova(candidatosParaConversaNova(lista));
      // Só há o que escolher com DOIS ou mais canais elegíveis — com um, a
      // escolha já está feita (critério de aceite: o fluxo segue direto).
      if (elegiveis.length > 1) {
        setPendente(alvo);
        return;
      }
      await executar(alvo, elegiveis[0]?.id);
    } finally {
      setAbrindo(false);
    }
  }

  function escolher(channelSessionId: string) {
    const alvo = pendente;
    setPendente(null);
    if (!alvo) return;
    setAbrindo(true);
    void executar(alvo, channelSessionId).finally(() => setAbrindo(false));
  }

  function cancelar() {
    if (!abrindo) setPendente(null);
  }

  return {
    iniciarConversa,
    /** Uma requisição em voo — quem renderiza desabilita o botão dela. */
    abrindo,
    /** Renderizar incondicionalmente; fica `null` quando não há escolha. */
    seletor: pendente ? (
      <SeletorDeCanalParaConversa
        candidatos={candidatos}
        abrindo={abrindo}
        aoEscolher={escolher}
        aoCancelar={cancelar}
      />
    ) : null,
  };
}
