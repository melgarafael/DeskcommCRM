"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { ChannelDeletionImpact } from "@/app/api/v1/channel-sessions/[id]/route";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  channelLabel,
  useChannelSessions,
  type ChannelSession,
} from "@/hooks/channels/useChannelSessions";
import { usePacingKnobs } from "@/hooks/channels/usePacingKnobs";
import { AntiBanSheet } from "./AntiBanSheet";
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
  Phone,
  Plus,
  ShieldCheck,
  Trash,
  Warning,
} from "@/lib/ui/icons";
import { lerEstadoDoCanal } from "@/lib/channels/estado";

type Variant = "success" | "warning" | "error" | "neutral";

/**
 * O vocabulário saiu daqui para `lib/channels/estado.ts`, sem mudar uma palavra:
 * esta era a tradução mais completa do produto (cobre os cinco valores do CHECK)
 * e virou a fonte única. O que MUDOU foi o fallback — ele devolvia
 * `{ label: status }`, ou seja, o enum cru na tela no dia em que aparecesse um
 * estado fora da lista.
 */
function statusInfo(status: string): { label: string; variant: Variant } {
  const l = lerEstadoDoCanal(status);
  return { label: l.rotulo, variant: l.tom };
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
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

/** "3 conversas" / "1 conversa" — ou nada, quando não há o que contar. */
function contar(n: number, singular: string, plural: string): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Junta os pedaços que sobraram numa enumeração legível ("a, b e c"). */
function enumerar(partes: (string | null)[]): string {
  const uteis = partes.filter((p): p is string => p !== null);
  const ultimo = uteis.pop() ?? "";
  return uteis.length > 0 ? `${uteis.join(", ")} e ${ultimo}` : ultimo;
}

export function ConnectionsClient({ wahaConfigured }: { wahaConfigured: boolean }) {
  const qc = useQueryClient();
  const {
    data: sessions,
    isLoading,
    isError,
    schemaOutdated,
  } = useChannelSessions({ refetchInterval: 10_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [qr, setQr] = useState<{ sessionId: string; title: string } | null>(null);
  const [antiBanId, setAntiBanId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ChannelSession | null>(null);
  const pacingItems = usePacingKnobs().data?.items ?? [];

  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: ["channel-sessions"] }),
    [qc],
  );

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
    try {
      const res = await apiClient.post<{ data: ChannelSession }>(
        "/api/v1/channel-sessions",
        {},
      );
      invalidate();
      setQr({ sessionId: res.data.id, title: "Conectar novo WhatsApp" });
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível iniciar a conexão."));
    } finally {
      setCreating(false);
    }
  }, [invalidate]);

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
        setQr({ sessionId: c.id, title: `Reconectar ${channelLabel(c)}` });
      } catch (err) {
        toast.error(errMsg(err, "Não foi possível reconectar."));
      } finally {
        setBusyId(null);
      }
    },
    [invalidate],
  );

  const forcePair = useCallback(
    async (sessionId: string) => {
      await apiClient.post(`/api/v1/channel-sessions/${sessionId}/reconnect`, { force: true });
      invalidate();
    },
    [invalidate],
  );

  const handleDeleted = useCallback(() => {
    setToDelete(null);
    invalidate();
  }, [invalidate]);

  const handleConnected = useCallback(() => {
    toast.success("WhatsApp conectado!");
    setQr(null);
    invalidate();
  }, [invalidate]);

  const list = sessions ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {isError
            ? "Não foi possível carregar seus números."
            : list.length === 0
              ? "Nenhum número conectado ainda."
              : `${list.length} ${list.length === 1 ? "número conectado" : "números conectados"}.`}
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
              Atualizar saúde
            </Button>
          )}
          <Button size="sm" disabled={creating || !wahaConfigured} onClick={handleConnectNew}>
            {creating ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <Plus size={14} aria-hidden />
            )}
            Conectar novo WhatsApp
          </Button>
        </div>
      </div>

      {!wahaConfigured && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">O serviço do WhatsApp não está configurado.</p>
          <p className="mt-1">
            Faltam o endereço e a chave do serviço (<code>WAHA_API_BASE_URL</code> e{" "}
            <code>WAHA_API_KEY</code>) nas variáveis de ambiente desta instalação. Enquanto isso,
            não dá para conectar, reconectar nem excluir os números pareados por QR — excluir um
            número também o desconecta do aparelho, e sem o serviço isso não acontece.
          </p>
          <p className="mt-1">
            Se você roda tudo na mesma máquina, o container sobe com{" "}
            <code>docker compose up -d waha</code>. Já apareceu aqui o caso oposto: o container
            no ar e o endereço configurado apontando para um lugar que não existe — subir o
            container de novo não conserta isso.
          </p>
        </div>
      )}

      {schemaOutdated && (
        <div className="rounded-md border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
          <p className="font-medium">Esta instalação está com o banco atrasado.</p>
          <p className="mt-1">
            Falta aplicar a migration que registra canal excluído. Até lá, um número que você
            excluir continua aparecendo nesta lista.
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando conexões…</p>
      ) : isError ? (
        // Lista vazia por falha de carregamento renderizava a tela de primeira
        // instalação ("conecte seu primeiro número") para quem já tem número no
        // ar — o convite exato para parear de novo um aparelho que já está
        // conectado. Erro tem que aparecer como erro.
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Warning size={28} className="text-error-fg" aria-hidden />
          <p className="text-sm text-error-fg">
            Não foi possível carregar seus números — esta lista não está mostrando o que existe.
          </p>
          <p className="text-xs text-muted-foreground">
            Não conecte um número novo por causa disto: recarregue a página. Se persistir, o
            servidor do sistema está fora do ar.
          </p>
        </Card>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <Phone size={28} className="text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Conecte seu primeiro número de WhatsApp para começar a atender.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const info = statusInfo(c.status);
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
                      <span className="truncate text-sm font-medium">{channelLabel(c)}</span>
                    </div>
                    {c.phone_number && c.display_name && (
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {c.phone_number}
                      </p>
                    )}
                  </div>
                  <Badge variant={info.variant}>{info.label}</Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {c.last_health_check_at
                    ? `Verificado ${new Date(c.last_health_check_at).toLocaleString("pt-PT")}`
                    : "Ainda não verificado"}
                </p>
                <div className="mt-auto flex gap-2">
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
                      Reconectar
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setAntiBanId(c.id)}>
                    <ShieldCheck size={14} aria-hidden />
                    Proteção de envio
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!podeExcluir}
                    aria-label={
                      podeExcluir
                        ? `Excluir ${channelLabel(c)}`
                        : `Excluir ${channelLabel(c)} — indisponível enquanto o serviço do WhatsApp não estiver ativo`
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

      <AntiBanSheet
        item={pacingItems.find((i) => i.channel_session.id === antiBanId) ?? null}
        canWrite
        onClose={() => setAntiBanId(null)}
      />

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
export function frasesDoImpacto(impact: ChannelDeletionImpact): string[] {
  if (impact.outcome === "delete") {
    return ["Este número não tem conversa, mensagem nem configuração ligada a ele."];
  }

  const noInbox = enumerar([
    contar(impact.history.conversations, "conversa", "conversas"),
    contar(impact.history.messages, "mensagem", "mensagens"),
  ]);
  const semNumero = enumerar([
    contar(impact.history.agent_versions, "versão de agente", "versões de agente"),
    contar(impact.configuration.ai_routers, "roteador de IA", "roteadores de IA"),
    contar(
      impact.configuration.channel_knobs,
      "ajuste de proteção de envio",
      "ajustes de proteção de envio",
    ),
  ]);

  const frases: string[] = [];
  if (noInbox) frases.push(`Continua no inbox: ${noInbox}.`);
  if (semNumero) frases.push(`Fica salvo, mas sem número — para de atender: ${semNumero}.`);
  // Sobra o caso em que só há registro interno (auditoria de envio): nada a
  // listar, mas o canal continua sendo arquivado, e prometer "não tem nada
  // ligado" seria falso.
  if (frases.length === 0) {
    frases.push("Este canal tem registros internos, por isso ele é arquivado em vez de apagado.");
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
          ? "Canal excluído."
          : conversas > 0
            ? `Canal removido. ${contar(conversas, "conversa continua", "conversas continuam")} no inbox.`
            : "Canal removido. O que estava ligado a ele continua guardado.",
      );
      onDeleted();
    } catch (err) {
      toast.error(errMsg(err, "Não foi possível excluir o canal."));
    } finally {
      setExcluindo(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !excluindo && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Excluir {channelLabel(canal)}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>O número será desconectado do WhatsApp e sai desta lista.</p>
              {isPending ? (
                <p>Verificando o que está ligado a este número…</p>
              ) : isError || !impact ? (
                <p>
                  Não foi possível verificar o que está ligado a este número. A exclusão continua
                  possível — quem decide apagar ou arquivar é o servidor, e ele preserva o
                  histórico quando existe.
                </p>
              ) : (
                <ul className="list-disc space-y-1 pl-5">
                  {frasesDoImpacto(impact).map((frase) => (
                    <li key={frase}>{frase}</li>
                  ))}
                </ul>
              )}
              <p>Para usar este número de novo, será preciso conectá-lo outra vez.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" disabled={excluindo} onClick={onCancel}>
            Cancelar
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
            Excluir
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
    const iv = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(iv);
  }, [status]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o código.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 py-2">
          {status === "SCAN_QR_CODE" ? (
            // Sem `key={tick}`: trocar só o src reaproveita o mesmo <img>, e o
            // browser segura o frame anterior até decodificar o novo. Remontar o
            // elemento a cada refresh é o que causaria o flash branco.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/channel-sessions/${sessionId}/qr?t=${tick}`}
              alt="QR Code para conectar WhatsApp"
              className="h-64 w-64 rounded-md border bg-white p-2"
            />
          ) : status === "WORKING" ? (
            <div className="flex flex-col items-center gap-2 text-sm font-medium text-success-fg">
              <CheckCircle size={28} weight="fill" aria-hidden />
              Conectado!
            </div>
          ) : status === "FAILED" || status === "STOPPED" ? (
            // Chegar aqui quase sempre significa credencial revogada: o número
            // foi desvinculado pelo celular e o engine não tem como voltar
            // sozinho. Antes esta tela era um beco sem saída ("tente
            // Reconectar" levava de volta ao mesmo FAILED); agora ela oferece a
            // única ação que de fato resolve.
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-error-fg">
                Este número foi desvinculado do WhatsApp. Para usá-lo de novo é preciso parear
                outra vez.
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
                    toast.error(errMsg(err, "Não foi possível gerar um novo QR."));
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
                Gerar novo QR
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={28} className="animate-spin" aria-hidden />
              Preparando o código…
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
