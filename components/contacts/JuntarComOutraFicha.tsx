"use client";
/**
 * JuntarComOutraFicha — juntar uma ficha com outra a partir da própria ficha
 * (spec 31, PR A). O operador acha a outra por nome ou telefone, confere os dois
 * cadastros lado a lado e junta com a mesma confirmação nomeada do
 * `MergeDialog`. A porta fica na ficha e só aparece para gestor.
 *
 * A fusão é o mesmo `POST /api/v1/contacts/merge`. O `useMergeContacts` já
 * invalida `["contact", id]` de quem ficou e de quem foi absorvido, então a
 * ficha atual se recarrega sozinha; quando ela própria é a absorvida, este
 * componente leva o operador para a ficha que ficou.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useMergeContacts } from "@/hooks/contacts/useMergeContacts";
import type { Contact } from "@/lib/types/contacts";
import { ComparacaoDeFichas } from "@/components/contacts/ComparacaoDeFichas";
import {
  ConfirmarJuncao,
  avisarResultadoDaJuncao,
} from "@/components/contacts/ConfirmarJuncao";

type FichaAtual = Pick<Contact, "id" | "name" | "display_name" | "phone_number">;

interface Props {
  contatoAtual: FichaAtual;
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
}

/** O intervalo entre a última tecla e a busca: menos que isso é ruído na rede. */
const ESPERA_DA_BUSCA_MS = 300;

/**
 * A lista só existe quando há um termo: montá-la antes faria a tela carregar a
 * primeira página de contatos sem nenhum pedido de quem opera.
 */
function ResultadosDaBusca({
  busca,
  contatoAtualId,
  onComparar,
}: {
  busca: string;
  contatoAtualId: string;
  onComparar: (c: Contact) => void;
}) {
  const t = useT();
  const q = useContactList({ search: busca, limit: 10 });

  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError) {
    return <p className="text-sm text-error-fg">{t("Não foi possível buscar agora.")}</p>;
  }

  // Anonimizada ou já absorvida não é ficha que se junta: a lista já esconde as
  // absorvidas, e a anonimizada sai aqui. Se o servidor deixar passar outra, a
  // própria fusão recusa e a mensagem vem por `showApiError`.
  const candidatos = (q.data?.pages.flatMap((p) => p.data) ?? []).filter(
    (c) => c.id !== contatoAtualId && !c.is_anonymized && !c.is_merged_into,
  );

  if (candidatos.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{t("Nenhuma ficha encontrada.")}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {candidatos.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{rotuloDoContato(c, t)}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {c.phone_number ? phoneForDisplay(c.phone_number) : (c.email ?? "—")}
            </span>
          </span>
          <Button size="sm" variant="outline" onClick={() => onComparar(c)}>
            {t("Comparar")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function JuntarComOutraFicha({ contatoAtual, open, onOpenChange }: Props) {
  const t = useT();
  const router = useRouter();
  const merge = useMergeContacts();
  const [termo, setTermo] = useState("");
  const [busca, setBusca] = useState("");
  const [escolhida, setEscolhida] = useState<Contact | null>(null);
  const [principal, setPrincipal] = useState(contatoAtual.id);
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setBusca(termo.trim()), ESPERA_DA_BUSCA_MS);
    return () => clearTimeout(h);
  }, [termo]);

  function fechar(aberto: boolean) {
    if (!aberto) {
      setTermo("");
      setBusca("");
      setEscolhida(null);
      setPrincipal(contatoAtual.id);
      setConfirmando(false);
    }
    onOpenChange(aberto);
  }

  function comparar(c: Contact) {
    setEscolhida(c);
    // O principal começa na ficha que o operador já está vendo: é o caminho que
    // não muda de tela. Trocar o rádio é a escolha explícita.
    setPrincipal(contatoAtual.id);
  }

  const absorvida = principal === contatoAtual.id ? escolhida : contatoAtual;
  const nomeDeQuemFica = rotuloDoContato(
    principal === contatoAtual.id ? contatoAtual : escolhida,
    t,
  );
  const nomeDaAbsorvida = absorvida ? rotuloDoContato(absorvida, t) : "";

  async function juntar() {
    if (!escolhida) return;
    setConfirmando(false);
    const secundario = principal === contatoAtual.id ? escolhida.id : contatoAtual.id;
    try {
      const res = await merge.mutateAsync({
        primary_contact_id: principal,
        secondary_contact_ids: [secundario],
      });
      avisarResultadoDaJuncao(res.data, t);
      fechar(false);
      // A ficha atual foi absorvida: ela deixou de existir como cadastro, então
      // o operador vai para a ficha que ficou.
      if (secundario === contatoAtual.id) {
        router.push(`/app/contacts/${principal}`);
      }
    } catch {
      /* showApiError já falou no toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Juntar com outra ficha")}</DialogTitle>
          <DialogDescription>
            {t("Escolha a ficha que vai ser absorvida. Confira os dois cadastros antes de juntar.")}
          </DialogDescription>
        </DialogHeader>

        {escolhida === null ? (
          <div className="space-y-3">
            <Input
              type="search"
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              placeholder={t("Buscar por nome ou telefone…")}
              aria-label={t("Buscar por nome ou telefone…")}
              autoFocus
            />
            {busca.length < 2 ? (
              <p className="text-sm text-muted-foreground">
                {t("Digite um nome ou telefone para achar a outra ficha.")}
              </p>
            ) : (
              <ResultadosDaBusca
                busca={busca}
                contatoAtualId={contatoAtual.id}
                onComparar={comparar}
              />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <ComparacaoDeFichas
              ids={[contatoAtual.id, escolhida.id]}
              principalId={principal}
              onEscolherPrincipal={setPrincipal}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEscolhida(null)}>
                {t("Voltar à busca")}
              </Button>
              <Button size="sm" onClick={() => setConfirmando(true)} disabled={merge.isPending}>
                {merge.isPending ? t("Juntando…") : t("Juntar")}
              </Button>
            </div>
            <ConfirmarJuncao
              aberto={confirmando}
              onAbertoChange={setConfirmando}
              nomeDeQuemFica={nomeDeQuemFica}
              nomesAbsorvidos={nomeDaAbsorvida}
              pendente={merge.isPending}
              onConfirmar={() => void juntar()}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => fechar(false)}>
            {t("Fechar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
