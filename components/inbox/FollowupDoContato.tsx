"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { rotuloDoStatus, tomDoStatus } from "@/lib/followup/eventos-legiveis";

/**
 * O enrollment vivo, como `ENROLLMENT_LIST_COLUMNS` o devolve.
 */
type EnrollmentRow = {
  id: string;
  pointer_id: string;
  contact_id: string;
  status: string;
  started_at: string;
  updated_at: string;
};

/**
 * O ponteiro de um fluxo de follow-up publicado — a fonte do `pointer_id` que
 * o POST de inscrição cobra. O GET sem `surface` já exclui os roteiros de
 * atendimento (eles não se inscrevem pelo relógio).
 */
type FlowRow = {
  id: string;
  name: string;
  status: string;
  active_version_id: string | null;
};

/**
 * Os status que OCUPAM A VAGA do contato: a lista do índice único
 * `idx_followup_enrollments_one_live` (`baseline.sql`) — a mesma de
 * `STATUS_VIVOS` em `lib/followup/silence-sweep.ts`, copiada aqui porque aquele
 * módulo é de servidor. Com um deles de pé, iniciar outro volta 409; por isso é
 * esta lista que decide entre oferecer Iniciar ou Parar.
 *
 * NÃO é o `LIVE_STATUSES` de `lib/followup/reactivity.ts` (quem reage a
 * mensagem, sem `paused_manual`) nem o do cancel (que aceita também
 * `coletando`, do roteiro de atendimento).
 */
const STATUS_QUE_OCUPAM_A_VAGA = ["active", "waiting_reply", "paused_handoff", "paused_manual"];

/**
 * A espera longa (migration 0308): a fila a mostra como viva, mas ela NÃO ocupa
 * a vaga e o cancel não a aceita. Aqui ela aparece com o status, sem Parar, e
 * Iniciar segue oferecido.
 */
const STATUS_DORMENTE = "dormente";

interface Props {
  contactId: string;
  /** Iniciar/parar são `manager`+ fora do modo suporte: falso esconde as ações de escrita. */
  podeEscrever: boolean;
}

/**
 * A lista, ou vazio. Se o formato vier diferente do contrato da rota, a seção
 * se oculta em vez de derrubar o painel inteiro — o mesmo princípio do estado
 * `erro` abaixo, e o que permite o painel ser montado por telas que só conhecem
 * o `crm-summary` (os dublês de um só `get` dos testes do painel).
 */
function listaDe<T>(valor: unknown): T[] {
  return Array.isArray(valor) ? (valor as T[]) : [];
}

/**
 * A PORTA DE FOLLOW-UP no painel da conversa (#3178).
 *
 * Qual fluxo está rodando neste contato, e as duas portas: iniciar um e parar o
 * que está de pé — sem sair do painel. Antes, isso só existia na fila de
 * follow-ups, longe da conversa onde a decisão é tomada.
 *
 * Lê o painel inteiro pelo MESMO canal (a rota, via `apiClient`), não por
 * react-query: assim o refetch da seção acompanha o do resumo, e os dublês de
 * um só `get` cobrem os dois. Como `RoteirosDoContato`, a seção se AUTO-OCULTA
 * quando não há enrollment vivo nem fluxo ativo — quem não usa o módulo não vê
 * a tela mudar.
 */
export function FollowupDoContato({ contactId, podeEscrever }: Props) {
  const t = useT();
  const [doContato, setDoContato] = useState<EnrollmentRow[] | null>(null);
  const [fluxos, setFluxos] = useState<FlowRow[] | null>(null);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [escolhido, setEscolhido] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!contactId) return;
    let cancelado = false;
    setErro(false);
    async function carregar() {
      try {
        // O recorte por contato é do servidor (`?contact_id=`); sem `status`,
        // porque "vivo" aqui é mais de um estado (ver STATUS_QUE_OCUPAM_A_VAGA).
        const [rEnroll, rFluxos] = await Promise.all([
          apiClient.get<{ data: EnrollmentRow[] }>(
            `/api/v1/ai/followups/enrollments?contact_id=${encodeURIComponent(contactId)}`,
          ),
          apiClient.get<{ data: FlowRow[] }>("/api/v1/ai/followup-flows"),
        ]);
        if (cancelado) return;
        setDoContato(listaDe<EnrollmentRow>(rEnroll.data).filter((e) => e.contact_id === contactId));
        setFluxos(listaDe(rFluxos.data));
      } catch {
        if (cancelado) return;
        // Falha de leitura NÃO vira "nada rodando": os dados ficam nulos e a
        // seção some (não afirma nada sobre o negócio em cima de um erro).
        setErro(true);
        setDoContato(null);
        setFluxos(null);
      }
    }
    void carregar();
    return () => {
      cancelado = true;
    };
  }, [contactId, tentativa]);

  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  // A rota ordena por `updated_at` desc: o primeiro achado é o mais recente.
  const vivo = (doContato ?? []).find((e) => STATUS_QUE_OCUPAM_A_VAGA.includes(e.status)) ?? null;
  const dormente = vivo ? null : ((doContato ?? []).find((e) => e.status === STATUS_DORMENTE) ?? null);
  const exibido = vivo ?? dormente;
  const fluxosAtivos = (fluxos ?? []).filter((f) => f.status === "active" && f.active_version_id);
  const nomeDoFluxo = (pointerId: string) => (fluxos ?? []).find((f) => f.id === pointerId)?.name ?? null;

  const iniciar = useCallback(async () => {
    if (!escolhido) return;
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/ai/followups/enrollments", {
        pointer_id: escolhido,
        contact_id: contactId,
      });
      toast.success(t("Follow-up iniciado."));
      setEscolhido("");
      recarregar();
    } catch {
      toast.error(t("Não foi possível iniciar o follow-up."));
    } finally {
      setSalvando(false);
    }
  }, [escolhido, contactId, t, recarregar]);

  const parar = useCallback(async () => {
    if (!vivo) return;
    setSalvando(true);
    try {
      await apiClient.post(`/api/v1/ai/followups/enrollments/${vivo.id}/cancel`, {});
      toast.success(t("Follow-up encerrado."));
      recarregar();
    } catch {
      toast.error(t("Não foi possível encerrar o follow-up."));
    } finally {
      setSalvando(false);
    }
  }, [vivo, t, recarregar]);

  if (!contactId) return null;
  const carregando = !erro && (doContato === null || fluxos === null);
  if (carregando) return <Skeleton className="h-14 w-full" data-testid="inbox-followup-carregando" />;
  if (erro) return null;
  const podeIniciar = !vivo && podeEscrever && fluxosAtivos.length > 0;
  // Nada a mostrar e nada a iniciar: a seção não existe (contrato de RoteirosDoContato).
  if (!exibido && !podeIniciar) return null;

  return (
    <section data-testid="inbox-followup">
      <h3 className="text-xs font-semibold text-text">{t("Follow-up")}</h3>
      {exibido && (
        <div className="mt-2 rounded-md border border-border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              {nomeDoFluxo(exibido.pointer_id) ?? t("Fluxo de follow-up")}
            </span>
            <Badge variant={tomDoStatus(exibido.status)}>{rotuloDoStatus(exibido.status, t)}</Badge>
          </div>
          {/* Parar só para quem ocupa a vaga: o cancel recusa o dormente. */}
          {vivo && podeEscrever && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              data-testid="parar-followup"
              disabled={salvando}
              onClick={parar}
            >
              {t("Parar follow-up")}
            </Button>
          )}
        </div>
      )}
      {podeIniciar && (
        <div className="mt-2 space-y-2">
          {/* Select nativo (o mesmo idioma do "Desfecho da demanda"): o teste o
              aciona por selectOptions, sem portal. */}
          <select
            aria-label={t("Fluxo de follow-up")}
            data-testid="escolher-fluxo-followup"
            className="w-full rounded-md border bg-background p-2 text-xs"
            value={escolhido}
            onChange={(e) => setEscolhido(e.target.value)}
          >
            <option value="">{t("Escolha o fluxo")}</option>
            {fluxosAtivos.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            data-testid="iniciar-followup"
            disabled={salvando || !escolhido}
            onClick={iniciar}
          >
            {t("Iniciar follow-up")}
          </Button>
        </div>
      )}
    </section>
  );
}
