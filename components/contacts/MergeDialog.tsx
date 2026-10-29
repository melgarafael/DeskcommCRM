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
 * ─── Parecidos (spec 31, PR A) ──────────────────────────────────────────────
 * Par que só tem NOME parecido não é prova de pessoa repetida: pode ser uma
 * empresa com nome semelhante. Por isso sai dos grupos fortes (telefone, e-mail)
 * e vai para a seção "Parecidos — confira", com os dados lado a lado. Juntar e
 * "Não são a mesma empresa" são de gestor; quem não é gestor só lê.
 *
 * ─── Vocabulário ───────────────────────────────────────────────────────────
 * Nada aqui conhece nicho. "Contato" é contato em e-commerce, clínica,
 * imobiliária e infoproduto; o `vocabulary` do funil renomeia lead/deal, não
 * pessoa.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { roleAtLeast } from "@/lib/auth/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  useContactDuplicates,
  type GrupoDuplicado,
} from "@/hooks/contacts/useContactDuplicates";
import { useMergeContacts } from "@/hooks/contacts/useMergeContacts";
import { useDispensarParecido } from "@/hooks/contacts/useDispensarParecido";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { MotivoDeDuplicidade } from "@/lib/contacts/duplicados";
import { ComparacaoDeFichas } from "@/components/contacts/ComparacaoDeFichas";
import {
  ConfirmarJuncao,
  avisarResultadoDaJuncao,
} from "@/components/contacts/ConfirmarJuncao";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const ROTULO_DO_MOTIVO: Record<MotivoDeDuplicidade, string> = {
  telefone: "mesmo telefone",
  email: "mesmo e-mail",
  telefone_em_conflito: "telefone que o WhatsApp deixou em conflito",
  nome_parecido: "nome parecido",
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
      avisarResultadoDaJuncao(res.data, t);
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
              <span className="block truncate font-medium">{rotuloDoContato(c, t)}</span>
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

      <ConfirmarJuncao
        aberto={confirmando}
        onAbertoChange={setConfirmando}
        nomeDeQuemFica={nomeDeQuemFica}
        nomesAbsorvidos={nomesAbsorvidos}
        pendente={merge.isPending}
        onConfirmar={() => void juntar()}
      />
    </div>
  );
}

/**
 * Um par de nome parecido: a comparação lado a lado, e, para gestor, as duas
 * saídas — juntar (mesma confirmação nomeada do grupo forte) ou dizer que não
 * são a mesma empresa.
 */
function GrupoParecido({
  grupo,
  onFundido,
  podeJuntar,
}: {
  grupo: GrupoDuplicado;
  onFundido: () => void;
  podeJuntar: boolean;
}) {
  const t = useT();
  const merge = useMergeContacts();
  const dispensar = useDispensarParecido();
  const [principal, setPrincipal] = useState(grupo.principal_sugerido);
  const [confirmando, setConfirmando] = useState(false);

  const [primeiro, segundo] = grupo.contatos;
  const idA = primeiro?.id ?? "";
  const idB = segundo?.id ?? "";
  const secundario = principal === idA ? idB : idA;
  const contatoPrincipal = grupo.contatos.find((c) => c.id === principal);
  const contatoAbsorvido = grupo.contatos.find((c) => c.id !== principal);
  const nomeDeQuemFica = contatoPrincipal ? rotuloDoContato(contatoPrincipal, t) : "";
  const nomeAbsorvido = contatoAbsorvido ? rotuloDoContato(contatoAbsorvido, t) : "";

  async function juntar() {
    setConfirmando(false);
    try {
      const res = await merge.mutateAsync({
        primary_contact_id: principal,
        secondary_contact_ids: [secundario],
      });
      avisarResultadoDaJuncao(res.data, t);
      onFundido();
    } catch {
      /* showApiError já falou no toast */
    }
  }

  async function naoSaoAMesma() {
    try {
      await dispensar.mutateAsync([idA, idB]);
      toast.success(t("Sugestão dispensada."));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.warning(t("Só gestor pode dispensar."));
      } else {
        showApiError(err);
      }
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-muted-foreground">
        {t("Agrupados por")}: {t(ROTULO_DO_MOTIVO.nome_parecido)}
      </p>

      <ComparacaoDeFichas
        ids={[idA, idB]}
        principalId={principal}
        onEscolherPrincipal={podeJuntar ? setPrincipal : undefined}
      />

      {podeJuntar ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void naoSaoAMesma()}
            disabled={dispensar.isPending}
          >
            {t("Não são a mesma empresa")}
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirmando(true)}
            disabled={merge.isPending || !secundario}
          >
            {merge.isPending ? t("Juntando…") : t("Juntar")}
          </Button>
          <ConfirmarJuncao
            aberto={confirmando}
            onAbertoChange={setConfirmando}
            nomeDeQuemFica={nomeDeQuemFica}
            nomesAbsorvidos={nomeAbsorvido}
            pendente={merge.isPending}
            onConfirmar={() => void juntar()}
          />
        </div>
      ) : null}
    </div>
  );
}

export function MergeDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const q = useContactDuplicates(open);
  // Juntar e "não são a mesma empresa" são de gestor (o piso de POST /contacts/merge).
  const podeJuntar = roleAtLeast(useActiveOrg()?.role, "manager");
  const grupos = q.data?.data ?? [];
  const fortes = grupos.filter((g) => !g.motivos.includes("nome_parecido"));
  const parecidos = grupos.filter((g) => g.motivos.includes("nome_parecido"));

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
        ) : fortes.length === 0 && parecidos.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("Nenhum contato duplicado encontrado.")}
          </p>
        ) : (
          <div className="space-y-3">
            {fortes.map((grupo) => (
              <GrupoDeDuplicados
                key={grupo.chave}
                grupo={grupo}
                onFundido={() => void q.refetch()}
              />
            ))}

            {parecidos.length > 0 ? (
              <section
                data-testid="parecidos-confira"
                className="space-y-3 border-t border-border pt-4"
              >
                <div>
                  <h3 className="text-sm font-semibold">{t("Parecidos — confira")}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "Fichas com nome parecido. Confira os dados lado a lado antes de juntar: pode ser só uma empresa com nome semelhante.",
                    )}
                  </p>
                </div>
                {parecidos.map((grupo) => (
                  <GrupoParecido
                    key={grupo.chave}
                    grupo={grupo}
                    onFundido={() => void q.refetch()}
                    podeJuntar={podeJuntar}
                  />
                ))}
              </section>
            ) : null}
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
