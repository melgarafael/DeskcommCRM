"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { ChannelRoutingSettings } from "@/lib/routing/channel-policies";
import { toast } from "sonner";

import type { ChannelDeletionImpact } from "@/app/api/v1/channel-sessions/[id]/route";
import type { ResultadoDoLoteDePausa } from "@/app/api/v1/channel-sessions/disabled/route";
import { copyToClipboard } from "@/lib/clipboard";
import { randomId } from "@/lib/random-id";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  channelLabel,
  useChannelSessions,
  type ChannelSession,
} from "@/hooks/channels/useChannelSessions";
import {
  CHANNEL_PROVIDER_SOCIAL,
  DEFAULT_CHANNEL_PROVIDER,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/capabilities";
import { usePacingKnobs } from "@/hooks/channels/usePacingKnobs";
import { AntiBanSheet } from "./AntiBanSheet";
import { GruposSheet } from "./GruposSheet";
import { PairingOptions } from "./PairingOptions";
import { ChannelAcervo } from "./ChannelAcervo";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ParaIntegrar } from "./ParaIntegrar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Pause,
  Phone,
  Play,
  Plus,
  ShieldCheck,
  Trash,
  UsersThree,
  Warning,
} from "@/lib/ui/icons";
import { canalDesativado } from "@/lib/channels/desativado";
import { lerEstadoDoCanal } from "@/lib/channels/estado";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";
import { useT } from "@/hooks/i18n/useT";
import { AgendaDePausa } from "@/components/connections/AgendaDePausa";

type Variant = "success" | "warning" | "error" | "neutral";

/**
 * O vocabulário saiu daqui para `lib/channels/estado.ts`, sem mudar uma palavra:
 * esta era a tradução mais completa do produto (cobre os cinco valores do CHECK)
 * e virou a fonte única. O que MUDOU foi o fallback — ele devolvia
 * `{ label: status }`, ou seja, o enum cru na tela no dia em que aparecesse um
 * estado fora da lista.
 */
function statusInfo(
  status: string,
  t: (texto: string) => string,
): { label: string; variant: Variant } {
  const l = lerEstadoDoCanal(status);
  return { label: t(l.rotulo), variant: l.tom };
}

function errMsg(err: unknown, fallback: string, t: (texto: string) => string): string {
  return err instanceof ApiError && err.message ? t(err.message) : t(fallback);
}

/**
 * "Este canal VIVE no serviço de WhatsApp?" — perguntado pelo nome da sessão,
 * que é o que as rotas de sessão de fato param, deslogam e apagam; a tela não
 * precisa conhecer provider nenhum.
 *
 * Duas perguntas da tela se respondem por aqui, e as duas na mesma direção:
 * excluir precisa do serviço no ar (a rota desloga o aparelho antes) e
 * RECONECTAR só existe para quem tem sessão a reiniciar. O canal oficial não tem
 * nenhuma das duas — a rota de reconectar o recusa com 422 —, então oferecer o
 * botão seria prometer uma ação que a API já sabe que não vai fazer.
 *
 * O lado que importa é garantido pelo schema: `channel_sessions_provider_ref_check`
 * exige nome de sessão em toda linha pareada por QR, então nenhuma delas escapa
 * da guarda. O canal oficial nasce sem esse nome (nada no código o grava nele) e
 * é revogado por credencial, sem tocar no transporte. Se algum dia uma linha
 * oficial guardar nome de sessão, o efeito é o botão exigir o serviço à toa:
 * restringe demais, nunca promete de menos.
 */
function dependeDoTransporte(c: ChannelSession): boolean {
  return Boolean(c.waha_session_name);
}

/**
 * "Este número fala pelo canal OFICIAL?" — perguntado pela FONTE das definições
 * do canal, que é o único lugar do repo que diz `oficial` para uma linha de
 * `channel_sessions` sem que a tela precise nomear provider nenhum.
 *
 * ⚠️ `!dependeDoTransporte(c)` responderia outra pergunta — "não tem sessão no
 * transporte" — e a diferença não é acadêmica: um número pareado por QR recém
 * criado, ainda sem nome de sessão, ganharia a etiqueta de oficial. Ali o erro
 * de pecar por excesso só escondia um botão (está escrito acima); aqui ele
 * AFIRMA à pessoa que opera algo falso sobre o número dela.
 */
function ehCanalOficial(c: ChannelSession): boolean {
  return fonteDeTemplates(c.provider) === "oficial";
}

/** "3 conversas" / "1 conversa" — ou nada, quando não há o que contar. */
function contar(
  n: number,
  singular: string,
  plural: string,
  t: (texto: string) => string,
): string | null {
  if (n <= 0) return null;
  return `${n} ${t(n === 1 ? singular : plural)}`;
}

/** Junta os pedaços que sobraram numa enumeração legível ("a, b e c"). */
function enumerar(partes: (string | null)[], t: (texto: string) => string): string {
  const uteis = partes.filter((p): p is string => p !== null);
  const ultimo = uteis.pop() ?? "";
  return uteis.length > 0 ? `${uteis.join(", ")} ${t("e")} ${ultimo}` : ultimo;
}

/**
 * A conta da ação em lote em frases que o operador lê de uma vez (issue #2387).
 *
 * Exportada para teste porque é a parte que MENTE quando erra: os critérios 1, 2
 * e 5 da issue são asserções sobre ESTA função — "um toast diz quantos mudaram
 * e quantos já estavam", "arquivado fica fora sem virar erro" e "a tela nunca
 * afirma sucesso total com falha preenchida". Um teste que só clicasse no botão
 * provaria que o clique chega ao endpoint, não que a frase é verdadeira.
 *
 * As três contagens saem juntas porque são a mesma operação vista por três
 * ângulos; `falharam` DOMINA a frase: havendo um id que não saiu, não existe
 * toast de sucesso — nem que todos os outros tenham mudado. É por isso que o
 * retorno separa `sucesso` de `erro` em vez de devolver uma string só: quem
 * chama não precisa lembrar dessa regra para não mentir.
 *
 * `arquivados` entra na frase (é canal que ficou de fora, não um erro — o
 * critério 2) e `jaEstavam` também (é a idempotência tornada visível — o
 * critério 3: repetir "Pausar todas" devolve esta linha, não um segundo audit).
 */
export function frasesDoLoteDePausa(
  resultado: ResultadoDoLoteDePausa,
  t: (texto: string) => string = (texto) => texto,
): { sucesso: string | null; erro: string | null } {
  const { disabled: pausar } = resultado;

  const contagens: (string | null)[] = [
    resultado.alterados > 0
      ? contar(
          resultado.alterados,
          pausar ? "canal pausado agora" : "canal reativado agora",
          pausar ? "canais pausados agora" : "canais reativados agora",
          t,
        )
      : null,
    resultado.jaEstavam > 0
      ? contar(
          resultado.jaEstavam,
          pausar ? "canal já estava pausado" : "canal já estava reativado",
          pausar ? "canais já estavam pausados" : "canais já estavam reativados",
          t,
        )
      : null,
    resultado.arquivados > 0
      ? contar(resultado.arquivados, "canal arquivado fica de fora", "canais arquivados ficam de fora", t)
      : null,
  ];
  const mudou = enumerar(contagens, t);

  if (resultado.falharam.length > 0) {
    // A falha vem com OS IDS: dizer "algo falhou" sem dizer o quê obriga o
    // operador a conferir canal por canal — que é justamente o trabalho que a
    // ação em lote existe para evitar.
    const falhou =
      `${pausar ? t("Não foi possível pausar") : t("Não foi possível retomar")} ` +
      `${contar(resultado.falharam.length, "canal", "canais", t)}: ${resultado.falharam.join(", ")}.`;
    return { sucesso: null, erro: mudou ? `${falhou} ${mudou}.` : falhou };
  }

  if (!mudou) return { sucesso: null, erro: null };
  // "Nada mudou" é o desfecho HONESTO da repetição: o lote é idempotente, e
  // dizer "3 canais pausados" quando nenhum mudou seria o mesmo sucesso falso
  // que a rota evita ao separar `alterados` de `jaEstavam`.
  const cabeca = resultado.alterados > 0 ? t("Feito:") : t("Nada mudou:");
  return { sucesso: `${cabeca} ${mudou}.`, erro: null };
}

export function ConnectionsClient({ wahaConfigured }: { wahaConfigured: boolean }) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const qc = useQueryClient();
  const {
    data: sessions,
    isLoading,
    isError,
    schemaOutdated,
  } = useChannelSessions({ refetchInterval: 10_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const createKey = useRef<string | null>(null);
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const routing = useQuery({ queryKey: ["channel-routing-settings"], queryFn: () => apiClient.get<{ data: ChannelRoutingSettings }>("/api/v1/settings/routing/channels") });
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [qr, setQr] = useState<{ sessionId: string; title: string } | null>(null);
  const [antiBanId, setAntiBanId] = useState<string | null>(null);
  const [gruposId, setGruposId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ChannelSession | null>(null);
  const pacingItems = usePacingKnobs().data?.items ?? [];

  // A mesma lista que a tela desenha é a que a ação em lote comanda: filtrar
  // social aqui (como a tela já faz) evita um botão que pede ids que ninguém vê.
  const list = (sessions ?? []).filter((session) => session.provider !== CHANNEL_PROVIDER_SOCIAL);
  /** Alvo de cada botão de lote — os dois só existem quando têm o que fazer. */
  const paraPausar = list.filter((c) => !canalDesativado(c.metadata));
  const paraRetomar = list.filter((c) => canalDesativado(c.metadata));

  // Mexer nos canais (criar, excluir, reconectar, health check) muda a LISTA de
  // conexões — e a ficha de Proteção de envio (`pacing-knobs`) é indexada por
  // ela. Invalidando só a primeira, a ficha ficava velha: o painel abria sem os
  // dados da conexão recém-criada (ou apontando para a excluída). As duas
  // listas andam juntas.
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["channel-sessions"] });
    void qc.invalidateQueries({ queryKey: ["pacing-knobs"] });
  }, [qc]);

  // Health check ao vivo de todos os canais — consulta o WAHA e grava
  // last_health_check_at. É a verificação de saúde de verdade (o status do DB
  // pode estar velho se o WAHA caiu sem emitir evento).
  const runHealthCheck = useCallback(
    async (list: ChannelSession[]) => {
      if (!wahaConfigured || list.length === 0) return;
      setChecking(true);
      try {
        await Promise.allSettled(
          list.map((c) => apiClient.get(`/api/v1/channel-sessions/${c.id}`)),
        );
        invalidate();
      } finally {
        setChecking(false);
      }
    },
    [wahaConfigured, invalidate],
  );

  const didInitialCheck = useRef(false);
  useEffect(() => {
    if (didInitialCheck.current || !sessions || sessions.length === 0) return;
    didInitialCheck.current = true;
    void runHealthCheck(sessions);
  }, [sessions, runHealthCheck]);

  const handleConnectNew = useCallback(async () => {
    setCreating(true);
    setConnectionDetail(null);
    try {
      const res = await apiClient.post<{ data: ChannelSession }>(
        "/api/v1/channel-sessions",
        {},
        { idempotencyKey: createKey.current ??= randomId(), timeoutMs: 120_000 },
      );
      invalidate();
      createKey.current = null;
      setQr({ sessionId: res.data.id, title: t("Conectar novo WhatsApp") });
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível iniciar a conexão.", t));
      if (err instanceof ApiError) setConnectionDetail(JSON.stringify({ code: err.code, request_id: err.requestId, ...err.details }, null, 2));
      invalidate();
    } finally {
      setCreating(false);
    }
  }, [invalidate, t]);

  // Reconexão suave: a maioria das quedas é passageira (rede, container
  // reiniciado) e a credencial pareada continua boa, então o número volta sem
  // ninguém pegar o celular. O modo que DESCARTA a credencial custa um
  // reescaneamento e por isso não é oferecido aqui — ele mora em `forcePair`, na
  // tela do QR, que só aparece depois que o modo suave falhou.
  const handleReconnect = useCallback(
    async (c: ChannelSession) => {
      setBusyId(c.id);
      try {
        await apiClient.post(`/api/v1/channel-sessions/${c.id}/reconnect`, {});
        invalidate();
        setQr({ sessionId: c.id, title: `${t("Reconectar")} ${channelLabel(c, t)}` });
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível reconectar.", t));
      } finally {
        setBusyId(null);
      }
    },
    [invalidate, t],
  );

  const forcePair = useCallback(
    async (sessionId: string) => {
      await apiClient.post(`/api/v1/channel-sessions/${sessionId}/reconnect`, { force: true });
      invalidate();
    },
    [invalidate],
  );

  // Pausar = canal desativado pelo operador: a entrega é gravada mas não entra
  // na inbox, não dispara IA e não gera follow-up. Reativar volta tudo sem
  // reimportar nada. Diferente de excluir: o canal continua listado.
  const handleToggleDisabled = useCallback(
    async (c: ChannelSession) => {
      const desligar = !canalDesativado(c.metadata);
      setBusyId(c.id);
      try {
        await apiClient.patch(`/api/v1/channel-sessions/${c.id}/disabled`, { disabled: desligar });
        toast.success(desligar ? t("Canal pausado.") : t("Canal reativado."));
        invalidate();
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível mudar o estado do canal.", t));
      } finally {
        setBusyId(null);
      }
    },
    [invalidate, t],
  );

  // Ação em lote (issue #2387): UMA requisição para a lista toda, UM invalidate
  // para a tela toda e um toast que divulga a conta que a API devolveu —
  // `alterados`, `jaEstavam` e, quando houver, os ids que não saíram. O caminho
  // do servidor é o mesmo da rota unitária (RPC `fn_definir_canal_desativado`,
  // um audit por canal), então o que muda aqui é só o número de cliques.
  const [loteOcupado, setLoteOcupado] = useState(false);
  const handleLote = useCallback(
    async (pausar: boolean) => {
      const alvo = (pausar ? paraPausar : paraRetomar).map((c) => c.id);
      if (alvo.length === 0) return;
      setLoteOcupado(true);
      try {
        const res = await apiClient.patch<{ data: ResultadoDoLoteDePausa }>(
          "/api/v1/channel-sessions/disabled",
          { disabled: pausar, ids: alvo },
        );
        // `frasesDoLoteDePausa` nunca devolve sucesso com falha preenchida; a
        // ordem abaixo não é otimização, é a garantia de que não há caminho que
        // avise "Feito" com um id em `falharam`.
        const frases = frasesDoLoteDePausa(res.data, t);
        if (frases.erro) toast.error(frases.erro);
        else if (frases.sucesso) toast.success(frases.sucesso);
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível mudar o estado dos canais.", t));
      } finally {
        setLoteOcupado(false);
        // Um só invalidate para a ação inteira: recarregar por canal seria os N
        // cliques que este botão existe para substituir (critério 8). Também
        // no caminho de erro — falha parcial mudou alguns canais de verdade.
        invalidate();
      }
    },
    [paraPausar, paraRetomar, invalidate, t],
  );

  const handleDeleted = useCallback(() => {
    setToDelete(null);
    invalidate();
  }, [invalidate]);

  const handleConnected = useCallback(() => {
    toast.success(t("WhatsApp conectado!"));
    setQr(null);
    invalidate();
  }, [invalidate, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {isError
            ? t("Não foi possível carregar seus números.")
            : list.length === 0
              ? t("Nenhum número conectado ainda.")
              : `${list.length} ${list.length === 1 ? t("número conectado") : t("números conectados")}.`}
        </p>
        <div className="flex gap-2">
          {list.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={checking || !wahaConfigured}
              onClick={() => void runHealthCheck(list)}
            >
              <ArrowsClockwise
                size={14}
                className={checking ? "animate-spin" : undefined}
                aria-hidden
              />
              {t("Atualizar saúde")}
            </Button>
          )}
          {/* Ação em lote (#2387): o "todas" que resolve a janela de manutenção
              do rodízio (#1330) — um número esquecido no meio de N cliques é o
              defeito que este botão existe para evitar. Cada um só aparece
              quando TEM alvo: "Retomar todas" com ninguém pausado seria um
              botão que promete uma conta que não fecha. Sem exigir o serviço do
              WhatsApp: pausar é gravar `metadata.disabled`, nada de transporte.
              O total no rótulo é o mesmo que o toast confirma depois — o
              operador vê a conta antes e depois do clique. */}
          {paraPausar.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={loteOcupado}
              onClick={() => void handleLote(true)}
            >
              {loteOcupado ? (
                <CircleNotch size={14} className="animate-spin" aria-hidden />
              ) : (
                <Pause size={14} aria-hidden />
              )}
              {t("Pausar todas")} ({paraPausar.length})
            </Button>
          )}
          {paraRetomar.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={loteOcupado}
              onClick={() => void handleLote(false)}
            >
              {loteOcupado ? (
                <CircleNotch size={14} className="animate-spin" aria-hidden />
              ) : (
                <Play size={14} aria-hidden />
              )}
              {t("Retomar todas")} ({paraRetomar.length})
            </Button>
          )}
          {/* A JANELA DE MANUTENÇÃO (#2388): o "todas" com HORÁRIO e RETOMADA
              automática. Ela fica ao lado dos dois botões de lote de propósito:
              os três são a mesma escrita (`metadata.disabled`), e a diferença é
              quando — agora, ou quando o operador escolher. */}
          <AgendaDePausa canais={list} />
          <Button size="sm" disabled={creating || !wahaConfigured} onClick={handleConnectNew}>
            {creating ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Plus size={14} aria-hidden />
            )}
            {t("Conectar novo WhatsApp")}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("Novos canais começam em modo de teste, sem respostas automáticas até você autorizar números ou liberar o público.")}
      </p>

      {list.length > 0 ? (
        <ParaIntegrar
          campos={[]}
          ajuda={
            <div className="space-y-1.5">
              <p>
                {t(
                  "No canal por QR a credencial é interna desta instalação e não serve para fora. Para ligar outro CRM ao mesmo número, conecte-o por uma sessão própria (novo QR).",
                )}
              </p>
              <p>
                {t(
                  "Dois dispositivos vinculados recebem as mesmas mensagens — se os dois tiverem atendimento automático, o cliente pode receber resposta dupla.",
                )}
              </p>
            </div>
          }
          aviso={
            <>
              {t("Não compartilhe esta sessão.")}{" "}
              {t("Crie uma conexão separada por QR no outro sistema.")}
            </>
          }
        />
      ) : null}
      {connectionDetail && <details className="rounded-md border p-3 text-sm"><summary>{t("Detalhes para suporte")}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{connectionDetail}</pre><Button variant="outline" size="sm" onClick={async () => {
        if (await copyToClipboard(connectionDetail)) toast.success(t("Copiado!"));
        else toast.error(t("Não foi possível copiar. Selecione e copie manualmente."));
      }}>{t("Copiar detalhes")}</Button></details>}
      <Link href="/app/settings/atendimento" className="text-sm underline">{t("Configurar responsáveis por número")}</Link>
      {!wahaConfigured && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">{t("O serviço do WhatsApp não está configurado.")}</p>
          <p className="mt-1">
            {t("Faltam o endereço e a chave do serviço (")}
            <code>WAHA_API_BASE_URL</code> {t("e")} <code>WAHA_API_KEY</code>
            {t(
              ") nas variáveis de ambiente desta instalação. Enquanto isso, não dá para conectar, reconectar nem excluir os números pareados por QR — excluir um número também o desconecta do aparelho, e sem o serviço isso não acontece.",
            )}
          </p>
          <p className="mt-1">
            {t("Se você roda tudo na mesma máquina, o container sobe com")}{" "}
            <code>docker compose up -d waha</code>
            {t(
              ". Já apareceu aqui o caso oposto: o container no ar e o endereço configurado apontando para um lugar que não existe — subir o container de novo não conserta isso.",
            )}
          </p>
        </div>
      )}

      {schemaOutdated && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">{t("Esta instalação está com o banco atrasado.")}</p>
          <p className="mt-1">
            {t(
              "Falta aplicar a migration que registra canal excluído. Até lá, um número que você excluir continua aparecendo nesta lista.",
            )}
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Carregando conexões…")}</p>
      ) : isError ? (
        // Lista vazia por falha de carregamento renderizava a tela de primeira
        // instalação ("conecte seu primeiro número") para quem já tem número no
        // ar — o convite exato para parear de novo um aparelho que já está
        // conectado. Erro tem que aparecer como erro.
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Warning size={28} className="text-error-fg" aria-hidden />
          <p className="text-sm text-error-fg">
            {t(
              "Não foi possível carregar seus números — esta lista não está mostrando o que existe.",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Não conecte um número novo por causa disto: recarregue a página. Se persistir, o servidor do sistema está fora do ar.",
            )}
          </p>
        </Card>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Phone size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            {t("Conecte seu primeiro número de WhatsApp para começar a atender.")}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const info = statusInfo(c.status, t);
            const pausado = canalDesativado(c.metadata);
            const policy = routing.data?.data?.channels?.find((channel) => channel.id === c.id);
            // Sem o serviço no ar a rota de exclusão falha fechado (503) para
            // quem depende dele: oferecer o botão seria prometer uma ação que
            // não acontece. O canal oficial não passa pelo transporte e continua
            // podendo ser excluído.
            const vivaNoTransporte = dependeDoTransporte(c);
            const podeExcluir = wahaConfigured || !vivaNoTransporte;
            return (
              <Card key={c.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Phone size={16} className="text-muted-foreground" aria-hidden />
                      <span className="truncate text-sm font-medium">{channelLabel(c, t)}</span>
                      {ehCanalOficial(c) && (
                        <Badge variant="default" className="shrink-0">
                          {t("API oficial")}
                        </Badge>
                      )}
                    </div>
                    {c.phone_number && c.display_name && (
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {c.phone_number}
                      </p>
                    )}
                  </div>
                  <Badge variant={info.variant}>{info.label}</Badge>
                  {pausado && <Badge variant="neutral">{t("Pausado")}</Badge>}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {c.last_health_check_at
                    ? `${t("Verificado")} ${new Date(c.last_health_check_at).toLocaleString(tagDoIdioma)}`
                    : t("Ainda não verificado")}
                </p>
                <ChannelAiAccess channelId={c.id} />
                {dependeDoTransporte(c) && <ChannelAcervo channelId={c.id} />}
                <p className="text-xs text-muted-foreground">{t(!policy ? "Consulte os responsáveis em Atendimento." : policy.mode === "legacy_unconfigured" ? "Usa todos os atendentes elegíveis da organização." : policy.mode === "restricted_empty" ? "Ninguém configurado — as conversas ficarão na fila." : "Somente as pessoas selecionadas recebem este número.")}</p>
                <div className="mt-auto flex flex-wrap gap-2">
                  {/* Some no canal oficial em vez de aparecer desabilitado: não é
                      indisponibilidade passageira (como o Excluir sem o serviço no
                      ar), é uma ação que não existe para esse canal — e o clique
                      ainda abriria o diálogo de QR, que ele nunca vai ter. */}
                  {vivaNoTransporte && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === c.id || !wahaConfigured}
                      onClick={() => handleReconnect(c)}
                    >
                      {busyId === c.id ? (
                        <CircleNotch size={14} className="animate-spin" aria-hidden />
                      ) : (
                        <ArrowsClockwise size={14} aria-hidden />
                      )}
                      {t("Reconectar")}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setAntiBanId(c.id)}>
                    <ShieldCheck size={14} aria-hidden />
                    {t("Proteção de envio")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === c.id}
                    aria-label={
                      pausado
                        ? `${t("Retomar")} ${channelLabel(c, t)}`
                        : `${t("Pausar")} ${channelLabel(c, t)}`
                    }
                    onClick={() => void handleToggleDisabled(c)}
                  >
                    {busyId === c.id ? (
                      <CircleNotch size={14} className="animate-spin" aria-hidden />
                    ) : pausado ? (
                      <Play size={14} aria-hidden />
                    ) : (
                      <Pause size={14} aria-hidden />
                    )}
                    {pausado ? t("Retomar") : t("Pausar")}
                  </Button>
                  {capabilitiesOf((c.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).groups !==
                    "none" && (
                    <Button variant="outline" size="sm" onClick={() => setGruposId(c.id)}>
                      <UsersThree size={14} aria-hidden />
                      {t("Grupos")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!podeExcluir}
                    aria-label={
                      podeExcluir
                        ? `${t("Excluir")} ${channelLabel(c, t)}`
                        : `${t("Excluir")} ${channelLabel(c, t)} — ${t("indisponível enquanto o serviço do WhatsApp não estiver ativo")}`
                    }
                    onClick={() => setToDelete(c)}
                  >
                    <Trash size={14} aria-hidden />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Só monta quando alguém pediu para abrir: assim o AntiBanSheet distingue
          "painel fechado" de "a conexão pedida sumiu da lista" — o segundo caso
          vira estado visível ali dentro, não um painel mudo. */}
      {antiBanId !== null && (
        <AntiBanSheet
          item={pacingItems.find((i) => i.channel_session.id === antiBanId) ?? null}
          canWrite
          onClose={() => setAntiBanId(null)}
        />
      )}

      {/* Sem checagem de papel aqui: quem chega a `ConnectionsClient` já passou
          pelo gate de `/app/connections` (admin+, `app/app/connections/page.tsx`),
          o mesmo motivo por trás do `canWrite` fixo do `AntiBanSheet` acima. A
          rota `groups` também exige `manager+` do lado do servidor. */}
      {gruposId !== null && <GruposSheet channelId={gruposId} onClose={() => setGruposId(null)} />}

      {toDelete && (
        <ExcluirCanalDialog
          canal={toDelete}
          onCancel={() => setToDelete(null)}
          onDeleted={handleDeleted}
        />
      )}

      {qr && (
        <QrDialog
          sessionId={qr.sessionId}
          title={qr.title}
          wahaConfigured={wahaConfigured}
          onClose={() => setQr(null)}
          onConnected={handleConnected}
          onForcePair={forcePair}
        />
      )}
    </div>
  );
}

/**
 * O que a exclusão faz com o que está pendurado no canal, em frases que o
 * operador reconhece.
 *
 * Exportada para teste porque é a parte que MENTE quando erra: a régua real de
 * apagar-ou-arquivar mora no servidor (`loadDeletionImpact`), e o diálogo só
 * traduz o preflight dela. Contagem zero não vira frase — "0 conversas" ocupa
 * espaço e não informa nada.
 */
export function frasesDoImpacto(
  impact: ChannelDeletionImpact,
  t: (texto: string) => string = (texto) => texto,
): string[] {
  if (impact.outcome === "delete") {
    return [t("Este número não tem conversa, mensagem nem configuração ligada a ele.")];
  }

  const noInbox = enumerar(
    [
      contar(impact.history.conversations, "conversa", "conversas", t),
      contar(impact.history.messages, "mensagem", "mensagens", t),
      // Registro de ligação entra na MESMA frase de "continua no inbox": para
      // quem opera, conversa e chamada são o mesmo histórico com o cliente. A
      // contagem nem existia, e o diálogo mostrava zeros enquanto o histórico
      // de voz sumia por cascade.
      contar(impact.history.voice_calls, "chamada de voz", "chamadas de voz", t),
    ],
    t,
  );
  const semNumero = enumerar(
    [
      contar(impact.history.agent_versions, "versão de agente", "versões de agente", t),
      contar(impact.configuration.ai_routers, "roteador de IA", "roteadores de IA", t),
      contar(
        impact.configuration.channel_knobs,
        "ajuste de proteção de envio",
        "ajustes de proteção de envio",
        t,
      ),
    ],
    t,
  );

  const frases: string[] = [];
  if (noInbox) frases.push(`${t("Continua no inbox:")} ${noInbox}.`);
  if (semNumero)
    frases.push(`${t("Fica salvo, mas sem número — para de atender:")} ${semNumero}.`);
  // Sobra o caso em que só há registro interno (auditoria de envio): nada a
  // listar, mas o canal continua sendo arquivado, e prometer "não tem nada
  // ligado" seria falso.
  if (frases.length === 0) {
    frases.push(
      t("Este canal tem registros internos, por isso ele é arquivado em vez de apagado."),
    );
  }
  return frases;
}

/**
 * Confirmação de exclusão que só promete o que o servidor vai fazer.
 *
 * O texto anterior era fixo, e texto fixo não descreve dois desfechos: ele
 * narrava o ramo que ARQUIVA ("as conversas continuam no inbox — só o canal é
 * removido") mesmo quando a linha vai ser apagada, e mandava "escanear o QR de
 * novo", que não existe no canal oficial. E calava justamente sobre o que o
 * operador teme perder — roteador de IA, versões de agente, ajuste de envio —,
 * que agora chega no preflight. O desfecho vem da MESMA função que o DELETE usa
 * para decidir, antes do clique.
 */
function ExcluirCanalDialog({
  canal,
  onCancel,
  onDeleted,
}: {
  canal: ChannelSession;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [excluindo, setExcluindo] = useState(false);
  const {
    data: impact,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["channel-deletion-impact", canal.id],
    queryFn: async () => {
      const res = await apiClient.get<{ data: { deletion_impact?: ChannelDeletionImpact } }>(
        `/api/v1/channel-sessions/${canal.id}?impact=1`,
      );
      return res.data.deletion_impact ?? null;
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });

  const excluir = async () => {
    setExcluindo(true);
    try {
      const res = await apiClient.delete<{
        data: { id: string; archived: boolean; impact: ChannelDeletionImpact };
      }>(`/api/v1/channel-sessions/${canal.id}`);
      const conversas = res.data.impact.history.conversations;
      toast.success(
        !res.data.archived
          ? t("Canal excluído.")
          : conversas > 0
            ? `${t("Canal removido.")} ${contar(conversas, "conversa continua", "conversas continuam", t)} ${t("no inbox.")}`
            : t("Canal removido. O que estava ligado a ele continua guardado."),
      );
      onDeleted();
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível excluir o canal.", t));
    } finally {
      setExcluindo(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !excluindo && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("Excluir")} {channelLabel(canal, t)}?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>{t("O número será desconectado do WhatsApp e sai desta lista.")}</p>
              {isPending ? (
                <p>{t("Verificando o que está ligado a este número…")}</p>
              ) : isError || !impact ? (
                <p>
                  {t(
                    "Não foi possível verificar o que está ligado a este número. A exclusão continua possível — quem decide apagar ou arquivar é o servidor, e ele preserva o histórico quando existe.",
                  )}
                </p>
              ) : (
                <ul className="list-disc space-y-1 pl-5">
                  {frasesDoImpacto(impact, t).map((frase) => (
                    <li key={frase}>{frase}</li>
                  ))}
                </ul>
              )}
              <p>{t("Para usar este número de novo, será preciso conectá-lo outra vez.")}</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" disabled={excluindo} onClick={onCancel}>
            {t("Cancelar")}
          </Button>
          {/* Enquanto o preflight não volta, confirmar seria confirmar no escuro:
              o diálogo ainda não sabe o que vai acontecer, então não pode pedir
              a decisão. */}
          <Button variant="destructive" disabled={excluindo || isPending} onClick={excluir}>
            {excluindo ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Trash size={14} aria-hidden />
            )}
            {t("Excluir")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QrDialog({
  sessionId,
  title,
  wahaConfigured,
  onClose,
  onConnected,
  onForcePair,
}: {
  sessionId: string;
  title: string;
  wahaConfigured: boolean;
  onClose: () => void;
  onConnected: () => void;
  onForcePair: (sessionId: string) => Promise<void>;
}) {
  const t = useT();
  const [status, setStatus] = useState<string>("STARTING");
  const [tick, setTick] = useState(0);
  const [pairing, setPairing] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (!wahaConfigured) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiClient.get<{ data: { status: string } }>(
          `/api/v1/channel-sessions/${sessionId}`,
        );
        if (cancelled) return;
        const s = res.data.status;
        setStatus(s);
        if (s === "WORKING" && !done.current) {
          done.current = true;
          onConnected();
        }
      } catch {
        // erro transitório de rede — o próximo tick tenta de novo
      }
    };
    void poll();
    const iv = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, wahaConfigured, onConnected]);

  // O QR do WhatsApp EXPIRA — medido no WAHA, a imagem muda a cada ~20s. Carregar
  // uma vez só (o que esta tela fazia) deixava um código morto na tela: quem
  // demorasse a pegar o celular escaneava algo que o WhatsApp já tinha
  // invalidado. Recarregamos a cada 15s enquanto estivermos em SCAN_QR_CODE,
  // com folga sobre a expiração.
  // A primeira imagem não precisa de tick novo: o <img> só é montado quando o
  // status vira SCAN_QR_CODE, e essa montagem já busca o QR do momento. O
  // intervalo cuida só das renovações seguintes.
  useEffect(() => {
    if (status !== "SCAN_QR_CODE") return;
    const iv = setInterval(() => setTick((v) => v + 1), 15_000);
    return () => clearInterval(iv);
  }, [status]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(
              "Escolha QR Code ou código de pareamento e confirme no WhatsApp do celular.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 py-2">
          {status === "SCAN_QR_CODE" ? (
            <PairingOptions key={sessionId} sessionId={sessionId} qr={
            // Sem `key={tick}`: trocar só o src reaproveita o mesmo <img>, e o
            // browser segura o frame anterior até decodificar o novo. Remontar o
            // elemento a cada refresh é o que causaria o flash branco.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/channel-sessions/${sessionId}/qr?t=${tick}`}
              alt={t("QR Code para conectar WhatsApp")}
              className="h-64 w-64 rounded-md border bg-white p-2"
            />
            } />
          ) : status === "WORKING" ? (
            <div className="flex flex-col items-center gap-2 text-sm font-medium text-success-fg">
              <CheckCircle size={28} weight="fill" aria-hidden />
              {t("Conectado!")}
            </div>
          ) : status === "FAILED" || status === "STOPPED" ? (
            // Chegar aqui quase sempre significa credencial revogada: o número
            // foi desvinculado pelo celular e o engine não tem como voltar
            // sozinho. Antes esta tela era um beco sem saída ("tente
            // Reconectar" levava de volta ao mesmo FAILED); agora ela oferece a
            // única ação que de fato resolve.
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-error-fg">
                {t(
                  "Este número foi desvinculado do WhatsApp. Para usá-lo de novo é preciso parear outra vez.",
                )}
              </p>
              <Button
                size="sm"
                disabled={pairing}
                onClick={async () => {
                  setPairing(true);
                  try {
                    await onForcePair(sessionId);
                    setStatus("STARTING");
                  } catch (err) {
                    toast.error(errMsg(err, "Não foi possível gerar um novo QR.", t));
                  } finally {
                    setPairing(false);
                  }
                }}
              >
                {pairing ? (
                  <CircleNotch size={14} className="animate-spin" aria-hidden />
                ) : (
                  <ArrowsClockwise size={14} aria-hidden />
                )}
                {t("Gerar novo QR")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={28} className="animate-spin" aria-hidden />
              {t("Preparando o código…")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
