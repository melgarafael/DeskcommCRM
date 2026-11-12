"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useContinuarPorOutroNumero } from "@/hooks/inbox/useContinuarPorOutroNumero";
import { type ConversaDoContato, useConversasDoContato } from "@/hooks/inbox/useConversasDoContato";
import { usePreviaDaTransferencia } from "@/hooks/inbox/usePreviaDaTransferencia";
import { useTransferConversation } from "@/hooks/inbox/useTransferConversation";
import { nomeDoCanal } from "@/lib/channels/estado";
import { outrosNumerosDoContato } from "@/lib/inbox/outros-numeros";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

export type AbaDeTransferencia = "atendente" | "numero";

interface Props {
  conversationId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Aba em que o diálogo abre. A faixa de número fora do ar abre em "numero". */
  abaInicial?: AbaDeTransferencia;
  /**
   * O que a aba Número precisa. Sem `numero`, a aba não aparece — é o caso de
   * quem chama o diálogo fora do Inbox. Com `numero`, ela aparece sempre que há
   * outro número com telefone, inclusive numa conversa de rede social cujo
   * contato tem telefone salvo: continuar pelo WhatsApp é justamente a saída.
   */
  numero?: {
    contactId: string;
    contactPhone: string | null;
    channelSessionId: string;
    /** Selecionar a conversa aberta no outro número (a seleção do Inbox é estado local). */
    onAbrirConversa: (id: string) => void;
  };
}

const ROLE_LABEL: Record<string, string> = {
  agent: "Atendente",
  manager: "Gestor",
  admin: "Admin",
};

/**
 * O rótulo de uma conversa na lista do diálogo (#4312): o NÚMERO por onde ela
 * acontece é o que distingue uma conversa da outra — é justamente o que a equipe
 * não vê hoje. Sem número (canal sem telefone), o nome do canal; e o cadastro do
 * número quando nem isso houver.
 */
function rotuloDaConversa(c: ConversaDoContato, t: (texto: string) => string): string {
  const telefone = c.channel_sessions?.phone_number?.trim();
  if (telefone) return telefone;
  const nome = c.channel_sessions?.display_name?.trim();
  if (nome) return nome;
  return t("Sem número");
}

/**
 * G3-01 — transferência imediata (decisão G1-06d): reatribui a conversa a
 * outro atendente da org, com motivo opcional. Cada transferência vira evento
 * auditável em conversation_assignment_events.
 *
 * A aba Número responde à outra metade de "transferir": continuar o atendimento
 * do mesmo contato por outro número da organização — o caso de quando o
 * telefone desta conversa cai e não havia por onde responder.
 */
export function ReassignDialog({
  conversationId,
  open,
  onOpenChange,
  abaInicial = "atendente",
  numero,
}: Props) {
  const t = useT();
  const { user } = useAuth();
  const members = useAssignableMembers(open);
  const transfer = useTransferConversation();
  const continuar = useContinuarPorOutroNumero();
  const { data: sessoes } = useChannelSessions({ enabled: open && numero != null });
  const [toUserId, setToUserId] = useState<string>("");
  const [reason, setReason] = useState("");
  const [aba, setAba] = useState<AbaDeTransferencia>(abaInicial);
  const [paraSessao, setParaSessao] = useState<string>("");

  const options = (members.data ?? []).filter((m) => m.user_id !== user.id);
  // #3642 (doc 237, 2-A): avisar ANTES de confirmar quando a conversa vai trocar
  // de número — o vendedor novo fala de um número que o cliente ainda não conhece.
  //
  // #3732: e avisar também quando o número NÃO vai mudar. Antes, `numero: null`
  // não dizia nada: quem transferia ficava sem saber que o destino não tem
  // número conectado (ou que o contato já tem conversa no número dele) e que a
  // conversa continua onde está. Só quando a prévia respondeu — enquanto carrega,
  // nenhum dos dois avisos aparece (o `null` do "ainda não sei" não é resposta).
  //
  // #4312: a MESMA prévia responde o que acontece com o negócio aberto do
  // contato. Quando quem transfere não é o dono do card, a transferência o deixa
  // com a outra pessoa — e o diálogo diz isso, com o nome de quem fica. O
  // contrário (o dono entregando o próprio negócio) também aparece: a equipe
  // sabe que o card foi junto.
  const previa = usePreviaDaTransferencia(conversationId, toUserId, open);
  const numeroNovo = previa.data?.numero ?? null;
  const negocio = previa.data?.negocio ?? null;
  const destino = options.find((m) => m.user_id === toUserId);
  // Com quem o negócio aberto fica quando ele não acompanha a transferência.
  const donoDoNegocio = negocio?.dono_user_id ?? null;
  const nomeDeQuemFica =
    donoDoNegocio === null
      ? t("outro atendente")
      : donoDoNegocio === user.id
        ? t("você")
        : (() => {
            const membro = (members.data ?? []).find((m) => m.user_id === donoDoNegocio);
            return membro ? rotuloDoMembro(membro, t) : t("outro atendente");
          })();
  const numeros = numero ? outrosNumerosDoContato(sessoes, numero.channelSessionId) : [];
  const temAbaNumero = numero != null && numeros.length > 0;
  const abaAtual = temAbaNumero ? aba : "atendente";
  // #4312 (defeito 3): as outras conversas do contato. Só na aba do atendente —
  // a aba Número tem o próprio seletor, e duas listas de número na mesma tela
  // seriam dois caminhos para a mesma decisão.
  const outrasConversas = useConversasDoContato(numero?.contactId, open && abaAtual === "atendente");

  function close(v: boolean) {
    if (!v) {
      setToUserId("");
      setReason("");
      setParaSessao("");
      setAba(abaInicial);
    }
    onOpenChange(v);
  }

  function continuarPeloNumero() {
    if (!numero || !paraSessao) return;
    continuar.mutate(
      { contact_id: numero.contactId, channel_session_id: paraSessao },
      {
        onSuccess: (id) => {
          close(false);
          numero.onAbrirConversa(id);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Transferir conversa")}</DialogTitle>
          <DialogDescription>
            {t(
              "A transferência é imediata: o atendente escolhido vira o responsável agora e a mudança fica registrada no histórico.",
            )}
          </DialogDescription>
        </DialogHeader>

        {temAbaNumero && (
          <Tabs value={abaAtual} onValueChange={(v) => setAba(v as AbaDeTransferencia)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="atendente">{t("Atendente")}</TabsTrigger>
              <TabsTrigger value="numero" data-testid="aba-transferir-numero">
                {t("Número")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {abaAtual === "numero" && numero ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reassign-numero">{t("Continuar pelo número")}</Label>
              <Select value={paraSessao} onValueChange={setParaSessao}>
                <SelectTrigger id="reassign-numero" className="w-full" data-testid="select-outro-numero">
                  <SelectValue placeholder={t("Escolha o número")} />
                </SelectTrigger>
                <SelectContent>
                  {numeros.map((n) => (
                    <SelectItem key={n.id} value={n.id} disabled={!n.conectado}>
                      {channelLabel(n, t)}
                      <span className="ml-1 text-muted-foreground">
                        · {n.conectado ? t("Conectado") : t("Desconectado")}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {numero.contactPhone ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "O cliente passa a receber as mensagens pelo número escolhido. Se a conversa lá estiver livre, você fica como responsável. O histórico deste número continua nesta conversa.",
                )}
              </p>
            ) : (
              <p className="text-xs text-destructive" role="status">
                {t("Este contato não tem telefone salvo, então não dá para falar com ele por outro número.")}
              </p>
            )}
          </div>
        ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reassign-target">{t("Transferir para")}</Label>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger id="reassign-target" className="w-full">
                <SelectValue
                  placeholder={members.isLoading ? t("Carregando atendentes…") : t("Escolha o atendente")}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {/*
                      O rótulo único (#3023): nome, senão e-mail, senão
                      "Atendente" + sufixo do hash do `user_id` — nunca os
                      dígitos do `user_id`, que não identificam ninguém para
                      quem transfere e vazam identificador interno para a tela.
                    */}
                    {rotuloDoMembro(m, t)}
                    <span className="ml-1 text-muted-foreground">
                      · {t(ROLE_LABEL[m.role] ?? m.role)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!members.isLoading && options.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("Nenhum outro atendente disponível nesta organização.")}
              </p>
            )}
            {numeroNovo && destino && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="aviso-numero-da-transferencia">
                {t("A conversa vai continuar pelo número de {nome} ({numero}).")
                  .replace("{nome}", rotuloDoMembro(destino, t))
                  .replace("{numero}", numeroNovo.phone_number?.trim() || nomeDoCanal(numeroNovo, t))}
              </p>
            )}
            {negocio && destino && previa.isSuccess && negocio.leva && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="aviso-negocio-acompanha">
                {t("O negócio aberto deste contato vai junto com a conversa.")}
              </p>
            )}
            {negocio && destino && previa.isSuccess && !negocio.leva && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="aviso-negocio-fica">
                {t("O negócio aberto deste contato continua com {nome} — a conversa vai sem ele.").replace(
                  "{nome}",
                  nomeDeQuemFica,
                )}
              </p>
            )}
            {!numeroNovo && destino && previa.isSuccess && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="aviso-numero-atual-da-transferencia">
                {t(
                  "A conversa continua no número em que está: o destino não tem número conectado do mesmo canal, ou o contato já tem conversa no número dele.",
                )}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reassign-reason">{t("Motivo (opcional)")}</Label>
            <Textarea
              id="reassign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("Ex.: cliente pediu falar com o financeiro")}
              maxLength={500}
              rows={2}
            />
          </div>

          {/* #4312 (defeito 3): o mesmo contato pode estar em mais de um número, e
              a conversa antiga não conta isso. A lista fica AQUI, no diálogo de
              Transferir — um segundo seletor na conversa seria outro caminho para
              a mesma decisão. */}
          {numero?.contactId && abaAtual === "atendente" && (
            <div className="space-y-1.5" data-testid="conversas-do-contato">
              <Label>{t("Conversas deste contato")}</Label>
              {outrasConversas.isSuccess &&
                (outrasConversas.data ?? []).filter((c) => c.id !== conversationId).length === 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="conversas-do-contato-vazio">
                    {t("Este contato não tem outra conversa.")}
                  </p>
                )}
              <ul className="space-y-1">
                {(outrasConversas.data ?? [])
                  .filter((c) => c.id !== conversationId)
                  .map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-2 text-xs"
                      data-testid={`conversa-do-contato-${c.id}`}
                    >
                      <span className="min-w-0 truncate">
                        {rotuloDaConversa(c, t)}
                        {c.assigned_to_user_name ? ` · ${c.assigned_to_user_name}` : ""}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          close(false);
                          numero?.onAbrirConversa?.(c.id);
                        }}
                      >
                        {t("Abrir")}
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {t("Cancelar")}
          </Button>
          {abaAtual === "numero" ? (
            <Button
              disabled={!paraSessao || !numero?.contactPhone || continuar.isPending}
              onClick={continuarPeloNumero}
              data-testid="btn-continuar-pelo-numero"
            >
              {continuar.isPending ? t("Abrindo…") : t("Continuar por este número")}
            </Button>
          ) : (
          <Button
            disabled={!toUserId || transfer.isPending}
            onClick={() =>
              transfer.mutate(
                {
                  conversation_id: conversationId,
                  to_user_id: toUserId,
                  reason: reason.trim() || undefined,
                },
                { onSuccess: () => close(false) },
              )
            }
          >
            {transfer.isPending ? t("Transferindo…") : t("Transferir")}
          </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
