"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UsersThree } from "@/lib/ui/icons";
import { ApiError } from "@/lib/api/types";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  useConvidarParticipante,
  useParticipantesDaConversa,
  useRemoverParticipante,
} from "@/hooks/inbox/useParticipantesDaConversa";

/**
 * ATENDIMENTO CONJUNTO no cabeçalho (issue #2542, fatia 4).
 *
 * ─── O que esta peça é, e o que ela NÃO é ──────────────────────────────────
 *
 * Ela mostra QUEM está nesta conversa (avatares e nomes, vindos do `GET
 * /participants`) e oferece o convite de um colega da organização. Ela NÃO
 * transfere: o dono da conversa continua o mesmo — quem entra como participante
 * lê e responde junto, e é isso que o botão precisa deixar claro do lado de
 * fora, senão o atendente que já foi transferido uma vez vai ler "convidar"
 * como "passar a bola".
 *
 * ─── De onde vêm os nomes ──────────────────────────────────────────────────
 *
 * A rota de participantes devolve o VÍNCULO (`user_id`, `joined_at`), não o
 * diretório de pessoas. O nome sai do mesmo lugar que o "Transferir" já lê
 * (`/api/v1/team/assignable`, via `useAssignableMembers`), cruzado pelo
 * `user_id`. Sem o cruzamento a lista mostraria UUID, e inventar um nome no
 * cliente seria pior que não mostrar nenhum.
 *
 * ─── O que a tela faz com a resposta da API ────────────────────────────────
 *
 * O convite é uma escrita que pode FALHAR, e cada falha tem um texto próprio no
 * servidor, já traduzido no idioma de quem chamou (`traduzir(…, user.idioma)`):
 * quem já participa não é erro (o `upsert` reabre a participação), quem é de
 * outra organização e quem é `viewer` recebem 422, e quem não é dono nem gestor
 * recebe 403. A tela mostra a MENSAGEM que veio, em `role="alert"` — não troca
 * por uma frase genérica, que apagaria justamente o motivo do recusado.
 *
 * O `ApiError.message` já chega no idioma do operador (o servidor traduziu). O
 * caso de rede — que não traz mensagem de rota — cai no `t()` da tela.
 */
interface Props {
  conversationId: string;
  /** Dono da conversa ou gestor+ — o mesmo gate da rota, para não oferecer o que ela recusa. */
  podeConvidar: boolean;
  atendenteId?: string;
  somenteLeitura?: boolean;
}

/** Iniciais para o fallback do avatar: sem nome, cai no `?` — nunca no vazio. */
function iniciais(nome: string | null | undefined): string {
  const partes = (nome ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return "?";
  const primeira = partes[0]?.[0] ?? "";
  const ultima = partes.length > 1 ? (partes.at(-1)?.[0] ?? "") : "";
  return `${primeira}${ultima}`.toUpperCase();
}

export function ParticipantesDaConversa({ conversationId, podeConvidar, atendenteId, somenteLeitura = false }: Props) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [alvo, setAlvo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [erroRemocao, setErroRemocao] = useState<string | null>(null);

  // A lista é lida sempre: quem participa interessa a quem vê a conversa, tenha
  // ele o poder de convidar ou não (o dono tem; o próprio convidado também). O
  // gate de QUEM pode pedir a lista mora no hook (`inbox.participantes.view`),
  // não aqui — `podeConvidar` é a régua do BOTÃO, e usá-la aqui tiraria a lista
  // do convidado.
  const participantes = useParticipantesDaConversa(conversationId, true);
  const convidar = useConvidarParticipante(conversationId);
  const remover = useRemoverParticipante(conversationId);
  const lista = participantes.data ?? [];
  // O diretório de pessoas serve a DOIS propósitos: nomear os avatares da lista
  // (que já está na tela) e popular o seletor. Por isso ele é buscado quando há
  // QUALQUER um dos dois — e não só com o diálogo aberto como no "Transferir".
  // Um avatar sem nome é um retângulo com "Atendente u2" dentro: a lista do
  // cabeçalho nasceria ilegível até alguém abrir o convite uma vez. A consulta é
  // a MESMA chave do `ReassignDialog` (`["team","assignable"]`, `staleTime` 60s),
  // então isto custa uma requisição por sessão, não uma por conversa.
  const membros = useAssignableMembers(podeConvidar || lista.length > 0);
  const idsQueParticipam = new Set(lista.map((p) => p.user_id));
  const nomeDe = (userId: string) => {
    const membro = (membros.data ?? []).find((m) => m.user_id === userId);
    return membro?.full_name ?? null;
  };

  // Sem poder convidar E sem ninguém na lista, esta peça não desenha nada: um
  // cabeçalho vazio de "atendimento conjunto" é ruído para quem só foi ler a
  // conversa.
  if (!podeConvidar && lista.length === 0) return null;

  async function confirmarConvite() {
    if (!alvo || convidar.isPending) return;
    setErro(null);
    try {
      await convidar.mutateAsync(alvo);
      // Fechar e limpar só no SUCESSO: no erro o diálogo fica aberto com a
      // mensagem, senão a pessoa teria de reabrir e reescolher para tentar de novo.
      setAberto(false);
      setAlvo("");
    } catch (err) {
      setErro(
        err instanceof ApiError
          ? err.message
          : t("Não foi possível convidar agora. Tente de novo."),
      );
    }
  }

  async function removerColega(userId: string) {
    setErroRemocao(null);
    try {
      await remover.mutateAsync(userId);
    } catch (err) {
      setErroRemocao(err instanceof ApiError ? err.message : t("Não foi possível remover agora. Tente de novo."));
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {lista.length > 0 && (
        <div
          className="flex items-center"
          data-testid="participantes-do-atendimento"
          aria-label={t("Quem participa desta conversa")}
        >
          {lista.map((p) => {
            const nome = nomeDe(p.user_id) ?? `${t("Atendente")} ${p.user_id.slice(0, 8)}`;
            const avatar = (
              <Avatar
                key={p.id}
                className="-ml-1.5 h-6 w-6 border border-background first:ml-0"
                data-testid={`participante-${p.user_id}`}
                title={nome}
              >
                <AvatarFallback className="bg-surface-elevated text-[10px] font-medium text-text-muted">
                  {iniciais(nomeDe(p.user_id))}
                </AvatarFallback>
              </Avatar>
            );
            const podeRemover = !somenteLeitura && (podeConvidar || p.user_id === atendenteId);
            if (!podeRemover) return avatar;
            return (
              <DropdownMenu key={p.id}>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`${t("Quem participa desta conversa")}: ${nome}`} disabled={remover.isPending} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                    {avatar}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => { void removerColega(p.user_id); }}>
                    {p.user_id === atendenteId ? t("Sair do atendimento") : t("Remover participante")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
        </div>
      )}

      {podeConvidar && !somenteLeitura && (
        <Button
          size="sm"
          variant="outline"
          data-testid="convidar-participante"
          title={t("Convida um colega para atender junto — o responsável pela conversa não muda.")}
          onClick={() => {
            setErro(null);
            setAberto(true);
          }}
        >
          <UsersThree size={14} aria-hidden className="mr-1" />
          {t("Convidar")}
        </Button>
      )}
      {erroRemocao && <p role="alert" className="text-xs text-destructive">{erroRemocao}</p>}

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Convidar colega")}</DialogTitle>
            <DialogDescription>
              {t(
                "O convidado passa a ver esta conversa e as mensagens dela, e pode responder junto. O responsável pela conversa continua o mesmo.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="convite-participante">{t("Convidar para atender junto")}</Label>
            <Select value={alvo} onValueChange={setAlvo}>
              <SelectTrigger id="convite-participante" className="w-full" data-testid="select-colega">
                <SelectValue
                  placeholder={membros.isLoading ? t("Carregando colegas…") : t("Escolha o colega")}
                />
              </SelectTrigger>
              <SelectContent>
                {(membros.data ?? []).map((m) => {
                  const jaParticipa = idsQueParticipam.has(m.user_id);
                  return (
                    <SelectItem key={m.user_id} value={m.user_id} disabled={jaParticipa}>
                      {m.full_name ?? `${t("Atendente")} ${m.user_id.slice(0, 8)}`}
                      {jaParticipa && (
                        <span className="ml-1 text-muted-foreground">· {t("Já participa")}</span>
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {!membros.isLoading && (membros.data ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("Nenhum outro atendente disponível nesta organização.")}
              </p>
            )}
            {erro !== null && (
              <p className="text-xs text-destructive" role="alert">
                {erro}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              disabled={!alvo || convidar.isPending}
              onClick={confirmarConvite}
              data-testid="confirmar-convite"
            >
              {convidar.isPending ? t("Convidando…") : t("Convidar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
