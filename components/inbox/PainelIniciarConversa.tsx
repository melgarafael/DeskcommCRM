"use client";
/**
 * O painel "Iniciar conversa" do Inbox (issue #2813).
 *
 * ─── Por que ele existe ─────────────────────────────────────────────────────
 *
 * Até aqui, começar uma conversa exigia passar pela tabela de Contatos: o
 * atendente abria Contatos, achava (ou criava) a ficha, clicava no ícone de
 * conversa. Quem trabalha o dia inteiro DENTRO do Inbox tinha de sair dele para
 * falar com alguém. Este painel traz o mesmo caminho para o topo da lista.
 *
 * ─── O que ele NÃO reinventa ────────────────────────────────────────────────
 *
 * Nada da regra de canal, de contato ou de atribuição mora aqui:
 *
 *   • a lista de números conectados e a escolha do canal saem de
 *     `useConversaNovaComEscolhaDeCanal` / `SeletorDeCanalParaConversa` — o
 *     MESMO componente que a tabela de Contatos usa (#2382). Canais sociais
 *     ficam de fora porque `candidatosParaConversaNova` já os exclui: eles não
 *     iniciam conversa com um contato de telefone. Aqui não há segunda peneira;
 *     duas listas divergem no dia em que uma ganhar regra nova;
 *   • o POST é o mesmo `POST /conversations/open-with-contact`, com o mesmo
 *     `channel_session_id` e o mesmo `role: agent` do servidor;
 *   • a ficha é reusada porque o painel manda `contact_id` quando o número
 *     digitado já é de alguém da base, em vez de mandar só o telefone e deixar
 *     a rota criar de novo;
 *   • a ATRIBUIÇÃO segue `useContinuarPorOutroNumero` (#2450): `claim` com
 *     `expected_assignee: null` grava o dono E o silêncio do bot na mesma
 *     transação. Abrir conversa por aqui não é abrir conversa para a IA.
 *
 * ─── O telefone digitado ────────────────────────────────────────────────────
 *
 * `normalizePhoneBR` (`lib/channels/phone-variants.ts`) é a régua do produto
 * para o telefone que chega de fora: DDD + número ganha `+55`, o celular ganha
 * o nono dígito, quem veio com `+` passa direto. A mesma função lê o CSV de
 * contatos e o webhook de captação.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  type AlvoDeConversa,
  useConversaNovaComEscolhaDeCanal,
} from "@/components/channels/SeletorDeCanalParaConversa";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { normalizePhoneBR, phoneForDisplay, samePhone } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ChatCircle, UserCircle, Users } from "@/lib/ui/icons";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useT } from "@/hooks/i18n/useT";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import type { Contact } from "@/lib/types/contacts";
import { cn } from "@/lib/utils";

/**
 * O corpo do painel — os três campos que o operador preenche.
 *
 * Mora num componente PRÓPRIO porque ele só deve EXISTIR com o diálogo aberto:
 * as duas leituras que ele faz (`/api/v1/contacts` e `/api/v1/message-templates`)
 * não têm por que sair no carregamento do Inbox para quem nem tocou no botão.
 * Dentro do `<DialogContent>` ele é montado só quando o diálogo abre, e
 * desmontado quando fecha — o estado novo a cada abertura vem de graça.
 */
function CorpoDoPainel({
  abrindo,
  aoConfirmar,
  aoCancelar,
}: {
  abrindo: boolean;
  aoConfirmar: (dados: { alvo: AlvoDeConversa; mensagem: string }) => void;
  aoCancelar: () => void;
}) {
  const t = useT();
  const [termo, setTermo] = useState("");
  const [termoBuscado, setTermoBuscado] = useState("");
  const [nome, setNome] = useState("");
  const [mensagem, setMensagem] = useState("");
  // `""` é o valor que o Radix lê como "nada escolhido" e troca pelo placeholder,
  // que é o rótulo visível do gatilho. Um valor que não é `SelectItem` deixaria a caixa vazia.
  const [modelo, setModelo] = useState("");
  const [contatoEscolhido, setContatoEscolhido] = useState<Contact | null>(null);

  /**
   * A busca anda 250 ms atrás da digitação: cada tecla é uma ida ao servidor, e
   * a lista de contatos de uma operação real é grande.
   */
  useEffect(() => {
    const id = setTimeout(() => setTermoBuscado(termo.trim()), 250);
    return () => clearTimeout(id);
  }, [termo]);

  const busca = useContactList({ search: termoBuscado || undefined, limit: 20 });
  const contatos = useMemo(
    () =>
      (busca.data?.pages.flatMap((pagina) => pagina.data) ?? []).filter(
        (c) => !c.is_anonymized && Boolean(c.phone_number),
      ),
    [busca.data],
  );

  const telefone = normalizePhoneBR(termo);

  /**
   * O número digitado já é de alguém da base? Então a ficha é DELA.
   *
   * A comparação é por `samePhone`, que enxerga o nono dígito: `+5531998966398` e
   * `+553198966398` são a mesma pessoa, e tratá-las como duas criaria o segundo
   * contato que a issue veio evitar.
   */
  const contatoDoTelefone = useMemo(() => {
    if (!telefone) return null;
    return contatos.find((c) => c.phone_number && samePhone(c.phone_number, telefone)) ?? null;
  }, [contatos, telefone]);

  const alvoContato = contatoEscolhido ?? contatoDoTelefone;
  const outros = contatos.filter((c) => c.id !== alvoContato?.id);

  const modelos = useMessageTemplates();
  const listaDeModelos = modelos.data ?? [];

  const alvo: AlvoDeConversa | null = alvoContato
    ? { contact_id: alvoContato.id }
    : telefone
      ? { phone_number: telefone, ...(nome.trim() ? { name: nome.trim() } : {}) }
      : null;

  return (
    <>
      <div className="space-y-4">
        {/* ── Passo 1: para quem ─────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <Label htmlFor="iniciar-conversa-para-quem">{t("Para quem")}</Label>
          <Input
            id="iniciar-conversa-para-quem"
            value={termo}
            autoComplete="off"
            placeholder={t("Telefone ou nome do contato")}
            onChange={(evento) => {
              setTermo(evento.target.value);
              setContatoEscolhido(null);
            }}
          />

          {alvoContato ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border border-primary bg-primary/5 px-3 py-2",
                "text-sm",
              )}
            >
              <UserCircle size={16} weight="regular" aria-hidden className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t("Contato existente")}: {rotuloDoContato(alvoContato, t)}
              </span>
            </div>
          ) : telefone ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <UserCircle size={16} weight="regular" aria-hidden className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t("Novo contato")}: {phoneForDisplay(telefone)}
              </span>
            </div>
          ) : null}

          {outros.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto pt-1">
              {outros.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm",
                    "hover:border-accent hover:bg-accent-soft",
                  )}
                  onClick={() => setContatoEscolhido(c)}
                >
                  <Users size={16} weight="regular" aria-hidden className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{rotuloDoContato(c, t)}</span>
                  {c.phone_number && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {phoneForDisplay(c.phone_number)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {termoBuscado.length >= 2 && !busca.isFetching && outros.length === 0 && !alvoContato && (
            <p className="text-xs text-muted-foreground">{t("Nenhum contato encontrado")}</p>
          )}
        </div>

        {/* ── Passo 3: nome do contato novo e primeira mensagem ───────────── */}
        {!alvoContato && (
          <div className="space-y-1.5">
            <Label htmlFor="iniciar-conversa-nome">{t("Nome (opcional)")}</Label>
            <Input
              id="iniciar-conversa-nome"
              value={nome}
              autoComplete="off"
              placeholder={t("Como o contato aparece no CRM")}
              onChange={(evento) => setNome(evento.target.value)}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="iniciar-conversa-mensagem">{t("Primeira mensagem")}</Label>
            {listaDeModelos.length > 0 && (
              <Select
                value={modelo}
                onValueChange={(escolhido) => {
                  setModelo(escolhido);
                  const achado = listaDeModelos.find((m) => m.id === escolhido);
                  if (achado) setMensagem(achado.body);
                }}
              >
                <SelectTrigger
                  className="h-7 w-auto gap-1 text-xs"
                  aria-label={t("Usar modelo de mensagem")}
                >
                  <SelectValue placeholder={t("Usar modelo de mensagem")} />
                </SelectTrigger>
                <SelectContent>
                  {listaDeModelos.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <Textarea
            id="iniciar-conversa-mensagem"
            value={mensagem}
            rows={3}
            placeholder={t("O que dizer ao contato (opcional)")}
            onChange={(evento) => setMensagem(evento.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("A conversa abre atribuída a você: a IA não assume este atendimento.")}
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={abrindo} onClick={aoCancelar}>
          {t("Cancelar")}
        </Button>
        <Button
          type="button"
          disabled={!alvo || abrindo}
          aria-busy={abrindo}
          onClick={() => {
            if (alvo) aoConfirmar({ alvo, mensagem: mensagem.trim() });
          }}
        >
          {abrindo ? t("Abrindo…") : t("Criar conversa")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function IniciarConversaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useAuth();
  /** A primeira mensagem, lida no `aoAbrir` — quando a conversa já existe. */
  const primeiraMensagem = useRef("");

  const { iniciarConversa, abrindo, seletor } = useConversaNovaComEscolhaDeCanal({
    aoAbrir: async (conversationId) => {
      /**
       * ATRIBUIR antes de qualquer mensagem. `expected_assignee: null` é o
       * contrato de "assuma se estiver livre" — o dono passa a ser quem iniciou
       * e o bot é silenciado na mesma transação (mesma chamada de
       * `useContinuarPorOutroNumero`). Recusa (409) significa que a conversa
       * reaberta já tinha dono: aí não se rouba atendimento de ninguém, e a
       * conversa segue aberta na tela.
       */
      let assumiu = true;
      try {
        await apiClient.post(`/api/v1/conversations/${conversationId}/claim`, {
          expected_assignee: null,
        });
      } catch (err) {
        // Só o 409 é "já tinha dono" — e o dono pode ser você (a conversa
        // fechada reabre com o dono antigo). Qualquer outra recusa (papel,
        // servidor, rede) deixa a conversa SEM dono e com o bot ligado. Nos
        // dois casos sem dono seu, a primeira mensagem não sai: não se fala
        // na conversa de outro atendente, nem numa que a IA ainda atende.
        // Mesma régua de `useContinuarPorOutroNumero`.
        if (!(err instanceof ApiError && err.status === 409)) {
          assumiu = false;
          showApiError(err);
        } else {
          const conversa = await apiClient
            .get<{ data: ConversationWithContact }>(`/api/v1/conversations/${conversationId}`)
            .then((r) => r.data)
            .catch(() => null);
          assumiu = conversa?.assigned_to_user_id === user.id;
          if (!assumiu) {
            toast.info(
              `${t("A conversa neste número está com")} ${
                conversa?.assigned_to_user_name ?? t("outro atendente")
              }.`,
            );
          }
        }
      }

      const texto = primeiraMensagem.current.trim();
      if (texto && assumiu) {
        try {
          await apiClient.post("/api/v1/messages", { conversation_id: conversationId, body: texto });
        } catch {
          // A conversa existe: perder a primeira frase é ruim, perder a tela é
          // pior. O erro é dito, e o atendente continua onde precisa estar.
          toast.error(t("A conversa abriu, mas a primeira mensagem não pôde ser enviada."));
        }
      }

      await qc.invalidateQueries({ queryKey: ["conversations"] });
      onOpenChange(false);
      router.push(`/app/inbox?id=${conversationId}`);
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Nova conversa")}</DialogTitle>
            <DialogDescription>
              {t(
                "Diga para quem e o que dizer. O canal de saída é você quem escolhe quando há mais de um número.",
              )}
            </DialogDescription>
          </DialogHeader>
          <CorpoDoPainel
            abrindo={abrindo}
            aoCancelar={() => onOpenChange(false)}
            aoConfirmar={({ alvo, mensagem }) => {
              primeiraMensagem.current = mensagem;
              void iniciarConversa(alvo);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* O seletor de canal (#2382) POR CIMA do painel: cancelar volta para os
          campos preenchidos, em vez de jogar fora o que já foi digitado. */}
      {seletor}
    </>
  );
}

/**
 * O botão do topo da lista do Inbox, com o painel atrás dele.
 *
 * A guarda de papel é a mesma do fluxo equivalente: `inbox.claim` é o posto
 * `agent`, que é o que a rota exige para abrir conversa em nome da organização.
 * Quem não pode atender não vê um botão que o servidor vai recusar.
 */
export function BotaoIniciarConversa() {
  const t = useT();
  const podeIniciar = usePermission("inbox.claim");
  const [aberto, setAberto] = useState(false);

  if (!podeIniciar) return null;

  return (
    <>
      <div className="px-3 pt-3">
        <Button
          type="button"
          variant="outline"
          className="w-full justify-center gap-2"
          onClick={() => setAberto(true)}
        >
          <ChatCircle size={16} weight="regular" aria-hidden />
          {t("Iniciar conversa")}
        </Button>
      </div>
      <IniciarConversaDialog open={aberto} onOpenChange={setAberto} />
    </>
  );
}
