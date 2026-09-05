"use client";
/**
 * MergeDialog — juntar contatos duplicados, pela tela.
 *
 * Este arquivo era andaime morto: ele lia `merge_queue` (uma tabela que nunca
 * teve produtor), o botão de ação nascia `disabled` e o texto mandava o operador
 * "mesclar via SQL". Ninguém o importava. Agora ele é a porta do recurso: lê
 * `GET /api/v1/contacts/duplicates` e chama `POST /api/v1/contacts/merge`.
 *
 * ─── Por que a escolha do principal é EXPLÍCITA ─────────────────────────────
 * A fusão não tem desfazer. O produto SUGERE um vencedor (`principal_sugerido`
 * — o de atividade mais recente), mas quem decide é quem opera, com o rádio na
 * frente e os dois cadastros lado a lado. Aplicar a sugestão sozinha economiza
 * um clique e cobra o preço de um cadastro errado que ninguém volta atrás.
 *
 * ─── E por que o "Juntar" pergunta antes ────────────────────────────────────
 * Este botão chamava a API DIRETO. Medido pela tela em 2026-09-04: um clique
 * disparava `POST /contacts/merge` em 253 ms, sem nenhum passo intermediário —
 * a única ação sem desfazer do produto era também a única sem porteiro. A
 * EXCLUSÃO de um contato, que é a ação menos grave das duas (some com um
 * cadastro; a fusão reescreve o histórico de dois), já abria um `AlertDialog`
 * em `ContactsTable`. O aviso de irreversibilidade que já existia aqui é
 * parágrafo de leitura: ele informa, mas não intercepta o clique errado — e o
 * rádio fica a poucos pixels do botão, então errar o alvo é barato.
 *
 * A confirmação NOMEIA quem fica e quem é absorvido, em vez de perguntar "tem
 * certeza?": o erro que ela precisa pegar não é "cliquei sem querer", é
 * "escolhi o vencedor errado", e para esse erro só o nome na frente serve.
 *
 * ─── Vocabulário ───────────────────────────────────────────────────────────
 * Nada aqui conhece nicho. "Contato" é contato em e-commerce, clínica,
 * imobiliária e infoproduto; o `vocabulary` do funil renomeia lead/deal, não
 * pessoa.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  useContactDuplicates,
  type GrupoDuplicado,
} from "@/hooks/contacts/useContactDuplicates";
import { useMergeContacts } from "@/hooks/contacts/useMergeContacts";
import type { MotivoDeDuplicidade } from "@/lib/contacts/duplicados";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const ROTULO_DO_MOTIVO: Record<MotivoDeDuplicidade, string> = {
  telefone: "mesmo telefone",
  email: "mesmo e-mail",
  telefone_em_conflito: "telefone que o WhatsApp deixou em conflito",
};

function GrupoDeDuplicados({
  grupo,
  onFundido,
}: {
  grupo: GrupoDuplicado;
  onFundido: () => void;
}) {
  const t = useT();
  const merge = useMergeContacts();
  const [principal, setPrincipal] = useState(grupo.principal_sugerido);
  const [confirmando, setConfirmando] = useState(false);

  const secundarios = grupo.contatos.map((c) => c.id).filter((id) => id !== principal);
  const contatoPrincipal = grupo.contatos.find((c) => c.id === principal);
  const nomeDeQuemFica = contatoPrincipal ? rotuloDoContato(contatoPrincipal, t) : "";
  const nomesAbsorvidos = grupo.contatos
    .filter((c) => c.id !== principal)
    .map((c) => rotuloDoContato(c, t))
    .join(", ");

  async function juntar() {
    setConfirmando(false);
    try {
      const res = await merge.mutateAsync({
        primary_contact_id: principal,
        secondary_contact_ids: secundarios,
      });
      const pendentes = Object.values(res.data.nao_repontado).reduce((a, b) => a + b, 0);
      // O parcial tem voz própria. Uma fusão que deixou linhas na lápide (por
      // colisão com um índice único de runtime) não é a mesma coisa que uma
      // fusão limpa, e dizer "pronto" nas duas esconderia justamente o caso em
      // que alguém precisa olhar.
      if (pendentes > 0) {
        toast.warning(
          t("Contatos juntados. {n} registro(s) continuaram no cadastro antigo — veja a auditoria.").replace(
            "{n}",
            String(pendentes),
          ),
        );
      } else {
        toast.success(t("Contatos juntados."));
      }
      onFundido();
    } catch {
      /* showApiError já falou no toast */
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        {t("Agrupados por")}: {grupo.motivos.map((m) => t(ROTULO_DO_MOTIVO[m])).join(", ")}
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {grupo.contatos.map((c) => (
          <label
            key={c.id}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
              c.id === principal ? "border-primary bg-primary/5" : "border-border bg-card"
            }`}
          >
            <input
              type="radio"
              name={`principal-${grupo.chave}`}
              className="mt-1"
              checked={c.id === principal}
              onChange={() => setPrincipal(c.id)}
              aria-label={t("Manter este cadastro")}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{rotuloDoContato(c)}</span>
              <span className="block truncate text-muted-foreground">{c.email ?? "—"}</span>
              <span className="block truncate text-muted-foreground">
                {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
              </span>
              {c.id === principal ? (
                <span className="mt-1 block text-xs font-medium text-primary">
                  {t("Este fica")}
                </span>
              ) : (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("Será absorvido por quem fica")}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            "Conversas, mensagens, negócios e histórico passam para quem fica. O cadastro antigo não é apagado — vira registro de fusão. Não há como desfazer.",
          )}
        </p>
        <Button
          size="sm"
          onClick={() => setConfirmando(true)}
          disabled={merge.isPending || secundarios.length === 0}
        >
          {merge.isPending ? t("Juntando…") : t("Juntar")}
        </Button>
      </div>

      {/*
        O porteiro da única ação sem desfazer. Ele NOMEIA os dois lados: o erro
        que precisa pegar é "escolhi o vencedor errado", e para esse erro
        "tem certeza?" não serve de nada.
      */}
      <AlertDialog open={confirmando} onOpenChange={setConfirmando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Juntar estes cadastros?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${nomeDeQuemFica} ${t("fica.")} ${nomesAbsorvidos} ${t(
                "será absorvido e sai da lista de contatos. Mensagens, negócios e histórico passam para quem fica. Não há como desfazer.",
              )}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={merge.isPending}>{t("Cancelar")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void juntar()}
              disabled={merge.isPending}
            >
              {merge.isPending ? t("Juntando…") : t("Juntar contatos")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function MergeDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const q = useContactDuplicates(open);
  const grupos = q.data?.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Contatos duplicados")}</DialogTitle>
          <DialogDescription>
            {t(
              "A mesma pessoa cadastrada duas vezes. Escolha qual cadastro fica; o outro é absorvido sem perder histórico.",
            )}
          </DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : grupos.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("Nenhum contato duplicado encontrado.")}
          </p>
        ) : (
          <div className="space-y-3">
            {grupos.map((grupo) => (
              <GrupoDeDuplicados
                key={grupo.chave}
                grupo={grupo}
                onFundido={() => void q.refetch()}
              />
            ))}
          </div>
        )}

        {/*
          O teto da varredura tem VOZ. Sem esta linha, uma base grande mostraria
          os grupos da primeira leva e o silêncio leria como "acabou" — a mesma
          classe de falha de um instrumento que devolve zero quando está cego.
        */}
        {q.data?.meta?.varreu_tudo === false ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "Mostrando os duplicados entre os contatos mais antigos. Junte estes e reabra para ver os próximos.",
            )}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Fechar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
