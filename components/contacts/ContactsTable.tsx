"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatRelative, isToday, isYesterday } from "date-fns";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { CaretDown, CaretUp, ChatCircle, Trash } from "@/lib/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useDeleteContact, mensagemDeBloqueioPorVinculo } from "@/hooks/contacts/useDeleteContact";
import type { ContactOrderBy } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { useConversaNovaComEscolhaDeCanal } from "@/components/channels/SeletorDeCanalParaConversa";

interface Props {
  contacts: Contact[];
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
}

function displayName(c: Contact, t: (texto: string) => string = (texto) => texto): string {
  return rotuloDoContato(c, t);
}

/** Hoje/ontem: relativo ("há 2 horas", "ontem"). Mais antigo: data, não dia da semana. */
// `locale` ANTES de `now`, e não depois: `now` tem default, e um parâmetro
// obrigatório atrás de um opcional obriga todo chamador a passar os dois. O
// codemod acrescentou no fim, que é o certo em 22 dos 23 casos e o errado aqui.
function formatUltimaAtividade(iso: string, locale: Locale, now = new Date()): string {
  const d = new Date(iso);
  if (isToday(d) || isYesterday(d)) {
    return formatRelative(d, now, { locale: locale });
  }
  return format(d, "dd/MM/yyyy", { locale: locale });
}

function SortableHead({
  label,
  column,
  orderBy,
  orderDir,
  onSort,
  className,
}: {
  label: string;
  column: ContactOrderBy;
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
  className?: string;
}) {
  const active = orderBy === column;
  const muted = "text-muted-foreground";
  const emphasis = "text-foreground";

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
        aria-sort={active ? (orderDir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="inline-flex flex-col -space-y-1" aria-hidden>
          <CaretUp
            size={12}
            weight="bold"
            className={active && orderDir === "asc" ? emphasis : muted}
          />
          <CaretDown
            size={12}
            weight="bold"
            className={active && orderDir === "desc" ? emphasis : muted}
          />
        </span>
      </button>
    </TableHead>
  );
}

export function ContactsTable({ contacts, orderBy, orderDir, onSort }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const clientesLigado = useActiveOrg()?.cliente_pela_agenda === true;
  const del = useDeleteContact();
  const [alvo, setAlvo] = useState<Contact | null>(null);
  const router = useRouter();
  const qc = useQueryClient();
  // Issue #2382 — seletor de canal ao INICIAR a conversa. O diálogo é o retorno
  // do hook (nulo quando não há o que escolher), e o que acontece depois de
  // abrir é daqui: invalidar a lista e navegar para o inbox.
  const {
    iniciarConversa: abrirConversa,
    abrindo,
    seletor: seletorDeCanal,
  } = useConversaNovaComEscolhaDeCanal({
    aoAbrir: async (conversationId) => {
      await qc.invalidateQueries({ queryKey: ["contacts"] });
      router.push(`/app/inbox?id=${conversationId}`);
    },
  });

  // Pré-checagem da exclusão (issue #1925): o diálogo "Excluir contato?" avisa
  // que a Agenda vai barrar ANTES do clique, com a MESMA contagem que o 409
  // usa (rota `contacts/[id]/vinculos`). Consulta só quando há alvo — uma
  // contagem por linha da lista seria N requisições para ver a tabela.
  // Se a prévia falhar, nada trava: sem ela o 409 continua barando e a frase
  // do erro já nomeia o vínculo.
  const alvoId = alvo?.id ?? null;
  const vinculos = useQuery({
    queryKey: ["contato-vinculos-para-excluir", alvoId],
    enabled: alvoId !== null,
    retry: false,
    queryFn: async () => {
      if (!alvoId) return { vinculos: [], por_tabela: {} };
      const corpo = await apiClient.get<{
        data?: { vinculos: string[]; por_tabela: Record<string, number> };
      }>(`/api/v1/contacts/${alvoId}/vinculos`);
      // O MESMO formato do `error.details` do 409: a frase da tela é uma só,
      // servida pela mesma função dos dois caminhos.
      return corpo.data ?? { vinculos: [], por_tabela: {} };
    },
  });
  const avisoDeVinculo = alvo ? mensagemDeBloqueioPorVinculo(vinculos.data, t) : null;

  async function iniciarConversa(c: Contact) {
    if (!c.phone_number || abrindo) return;
    // O hook decide se há escolha (issue #2382) e faz o POST; quem decide o
    // destino depois é `aoAbrir`, declarado acima.
    await abrirConversa({ contact_id: c.id, phone_number: c.phone_number });
  }

  async function confirmarExclusao() {
    if (!alvo) return;
    try {
      await del.mutateAsync(alvo.id);
      toast.success(t("Contato excluído."));
      setAlvo(null);
    } catch {
      // hook handles toast
    }
  }

  return (
    <>
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead
            label={t("Nome")}
            column="display_name"
            orderBy={orderBy}
            orderDir={orderDir}
            onSort={onSort}
          />
          <SortableHead
            label={t("Email")}
            column="email"
            orderBy={orderBy}
            orderDir={orderDir}
            onSort={onSort}
          />
          <SortableHead
            label={t("Telefone")}
            column="phone_number"
            orderBy={orderBy}
            orderDir={orderDir}
            onSort={onSort}
          />
          <TableHead>{t("Tags")}</TableHead>
          <SortableHead
            label={t("Última atividade")}
            column="last_activity_at"
            orderBy={orderBy}
            orderDir={orderDir}
            onSort={onSort}
          />
          <TableHead>{t("Status")}</TableHead>
          <TableHead className="w-[88px]">
            <span className="sr-only">{t("Ações")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contacts.map((c) => (
          <TableRow key={c.id} className="cursor-pointer">
            <TableCell className="font-medium">
              <Link href={`/app/contacts/${c.id}`} className="hover:underline">
                {displayName(c)}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {c.email ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {c.tags.length === 0
                  ? <span className="text-muted-foreground text-xs">—</span>
                  : c.tags.map((tag) => (
                      <ChipDeEtiqueta key={tag} tag={tag} />
                    ))}
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {c.last_activity_at
                ? formatUltimaAtividade(c.last_activity_at, localeDaData)
                : "—"}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {c.is_anonymized && <Badge variant="destructive">{t("Anonimizado")}</Badge>}
                {c.is_blocked && <Badge variant="warning">{t("Bloqueado")}</Badge>}
                {/*
                  Selo "Pessoal" lido da COLUNA, nunca da etiqueta (critério 5):
                  mesma regra do aviso acima — etiqueta se edita, coluna não.
                  "Ativo" some junto: pessoal está fora da operação, então
                  chamar de ativo mentiria na mesma linha em que o selo conta.
                */}
                {c.is_personal && <Badge variant="secondary">{t("Pessoal")}</Badge>}
                {/*
                  Lê a COLUNA, nunca a tag, e só com a regra ligada: a tag
                  `cliente` é removível à mão e pelo PATCH (que substitui `tags`
                  por inteiro), e um selo que some porque alguém editou
                  etiquetas mentiria sobre um fato. Desligada, a coluna está
                  congelada e o selo mentiria do outro lado.
                */}
                {clientesLigado && c.first_service_at && (
                  <Badge variant="secondary">{t("Cliente")}</Badge>
                )}
                {!c.is_anonymized && !c.is_blocked && !c.is_personal && (
                  <Badge variant="success">{t("Ativo")}</Badge>
                )}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-0.5">
                {c.conversa ? (
                  <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                    <Link
                      href={`/app/inbox?id=${c.conversa.id}`}
                      title={t("Abrir conversa no Inbox")}
                      aria-label={`${t("Abrir conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                    >
                      <ChatCircle size={16} weight="regular" aria-hidden />
                      {c.conversa.unread > 0 && (
                        <span className="sr-only">{c.conversa.unread} {t("sem ler")}</span>
                      )}
                    </Link>
                  </Button>
                ) : c.phone_number ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t("Iniciar conversa no Inbox")}
                    aria-label={`${t("Iniciar conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                    disabled={abrindo}
                    onClick={() => void iniciarConversa(c)}
                  >
                    <ChatCircle size={16} weight="regular" aria-hidden />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-error-fg"
                  title={t("Excluir contato")}
                  aria-label={`${t("Excluir contato")} ${displayName(c, t)}`}
                  onClick={() => setAlvo(c)}
                >
                  <Trash size={16} weight="regular" aria-hidden />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>

    <AlertDialog open={alvo !== null} onOpenChange={(open) => { if (!open) setAlvo(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir contato?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {alvo
              ? `${t("Isso remove")} ${displayName(alvo, t)} ${t("e a conversa associada, se houver. Esta ação não pode ser desfeita.")}`
              : null}
            {/*
              O aviso ANTES do clique (issue #1925): a recusa já nomeava o
              vínculo, mas só depois que a pessoa tentava. Mesma frase do 409
              (plural e chave vindos do servidor), e o link vai direto para a
              Agenda — é lá que o compromisso é cancelado.
            */}
            {avisoDeVinculo ? (
              <span className="mt-2 block text-sm font-medium text-warning-fg">
                {avisoDeVinculo}{" "}
                <Link href="/app/agenda" className="underline">
                  {t("Abrir Agenda")}
                </Link>
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>{t("Cancelar")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => void confirmarExclusao()}
            disabled={del.isPending}
          >
            {del.isPending ? t("Excluindo…") : t("Excluir")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Issue #2382 — o seletor de canal, quando há mais de um elegível. */}
    {seletorDeCanal}
    </>
  );
}
