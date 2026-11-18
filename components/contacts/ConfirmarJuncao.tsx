"use client";
/**
 * A confirmação da fusão, uma só para as três portas que juntam contatos: o
 * grupo forte de `MergeDialog`, o grupo parecido e "Juntar com outra ficha" na
 * ficha. Antes isto morava dentro de `GrupoDeDuplicados`; virou componente para
 * que a frase que NOMEIA quem fica e quem é absorvido não exista em três cópias.
 *
 * Quem chama faz a fusão; este componente só pergunta e devolve a resposta.
 */
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ResultadoDaFusao } from "@/hooks/contacts/useMergeContacts";

interface Props {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  nomeDeQuemFica: string;
  nomesAbsorvidos: string;
  pendente: boolean;
  onConfirmar: () => void;
}

/**
 * O porteiro da única ação sem desfazer. Ele NOMEIA os dois lados: o erro que
 * precisa pegar é "escolhi o vencedor errado", e para esse erro "tem certeza?"
 * não serve de nada.
 */
export function ConfirmarJuncao({
  aberto,
  onAbertoChange,
  nomeDeQuemFica,
  nomesAbsorvidos,
  pendente,
  onConfirmar,
}: Props) {
  const t = useT();
  return (
    <AlertDialog open={aberto} onOpenChange={onAbertoChange}>
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
          <AlertDialogCancel disabled={pendente}>{t("Cancelar")}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirmar} disabled={pendente}>
            {pendente ? t("Juntando…") : t("Juntar contatos")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * O aviso de uma fusão que terminou. O parcial tem voz própria: uma fusão que
 * deixou linhas na lápide não é a mesma coisa que uma fusão limpa, e dizer
 * "pronto" nas duas esconderia justamente o caso em que alguém precisa olhar.
 */
export function avisarResultadoDaJuncao(
  res: ResultadoDaFusao,
  t: (texto: string) => string,
): void {
  const pendentes = Object.values(res.nao_repontado).reduce((a, b) => a + b, 0);
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
}
