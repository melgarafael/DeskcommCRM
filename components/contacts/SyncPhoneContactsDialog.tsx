"use client";
import { useState } from "react";
import { toast } from "sonner";

import { ArrowsClockwise, Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import {
  capabilitiesOf,
  DEFAULT_CHANNEL_PROVIDER,
  transportaMensagem,
  type ChannelProvider,
} from "@/lib/channels/capabilities";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useSyncPhoneContacts, type ResumoDaAgenda } from "@/hooks/contacts/useSyncPhoneContacts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * "Sincronizar agenda do celular" (#2736): importa para o CRM os contatos
 * salvos na agenda do aparelho pareado.
 *
 * O resumo fica NO diálogo (e não só em toast), como no import de planilha:
 * "312 lidos, 40 importados, 270 já existentes, 2 ignorados" é a resposta de
 * 'o que aconteceu com a minha base?', e um toast some antes de dar tempo de
 * ler. Números que já estão no CRM não viram duplicata — a criação é a mesma
 * RPC do webhook, e o diálogo só diz quantos já existiam.
 */
export function SyncPhoneContactsDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const canais = useChannelSessions({ enabled: open });
  const sincronizar = useSyncPhoneContacts();
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [resumo, setResumo] = useState<ResumoDaAgenda | null>(null);
  /**
   * O cursor deste clique: começa em zero e passa a ser o `proximo_offset` que
   * o resumo devolveu. É o que faz o segundo clique continuar no contato 501 em
   * vez de reler as mil primeiras linhas e parar no milésimo (ponto 2 do CR).
   */
  const [retomada, setRetomada] = useState(0);

  // A pergunta é de CAPABILITY, não de provider — a tela não tem adapter em
  // mãos, então pergunta o que o canal PERMITE ("tem agenda do aparelho para
  // ler?") em vez de perguntar qual ele é, que é o que o invariante 1 da
  // doutrina proíbe. Só então o gesto é oferecido: um canal sem agenda viraria
  // um 409 na tela de quem clicou, ou seja, um botão que só sabe falhar.
  // `transportaMensagem` vem primeiro porque `capabilitiesOf` LANÇA para canal
  // que não conversa (a linha de voz), e lançar dentro do render derrubaria o
  // diálogo inteiro.
  const conectados = (canais.data ?? []).filter(
    (c) =>
      transportaMensagem(c.provider) &&
      capabilitiesOf((c.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).phonebook &&
      c.status === "WORKING",
  );
  const numero = escolhido ?? conectados[0]?.id ?? null;

  function reset() {
    setEscolhido(null);
    setResumo(null);
    setRetomada(0);
  }

  /**
   * Um clique = UMA passada da agenda, a partir de `retomada`. O
   * `proximo_offset` que a rota devolve vira o offset do clique seguinte — a
   * tela não guarda nada além dele, e nunca recomeça do zero escondido.
   */
  async function sincronizarAgora() {
    if (!numero || sincronizar.isPending) return;
    try {
      const r = await sincronizar.mutateAsync({ channelSessionId: numero, offset: retomada });
      setResumo(r);
      setRetomada(r.proximo_offset ?? 0);
      if (r.importados > 0) toast.success(`${r.importados} ${t("contato(s) sincronizado(s)")}`);
      if (r.ja_existentes > 0) toast.info(`${r.ja_existentes} ${t("contato(s) já existente(s) — nada duplicado")}`);
      if (r.erros > 0) toast.warning(`${r.erros} ${t("contato(s) com erro na gravação")}`);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? t(err.message)
          : t("Não foi possível ler a agenda do celular.");
      toast.error(msg);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await sincronizarAgora();
  }

  // Há próximo clique quando a passada cortou E disse de onde retomar. Quem
  // escolhe o número de novo (ou "Sincronizar de novo") recomeça do zero: o
  // cursor pertence à agenda daquele número.
  const continuar = resumo?.truncado === true && resumo.proximo_offset !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Sincronizar agenda do celular")}</DialogTitle>
          <DialogDescription>
            {t(
              "Importa para o CRM os contatos salvos na agenda do aparelho conectado. Números que já estão no CRM não viram duplicata. Se o aparelho tiver mais contatos que o teto de uma sincronização, clique de novo para continuar de onde parou.",
            )}
          </DialogDescription>
        </DialogHeader>

        {!resumo && (
          <form onSubmit={onSubmit} className="space-y-4">
            {canais.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : canais.isError ? (
              <p className="text-sm text-error-fg">{t("Não foi possível carregar seus números conectados.")}</p>
            ) : conectados.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Nenhum número conectado. Conecte um número em Conexões para sincronizar a agenda.")}
              </p>
            ) : (
              <>
                {conectados.length > 1 && (
                  <Select
                    value={numero ?? undefined}
                    onValueChange={(v) => {
                      // Outro número, outra agenda: o cursor do anterior não vale.
                      setEscolhido(v);
                      setRetomada(0);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("Escolha o número")} />
                    </SelectTrigger>
                    <SelectContent>
                      {conectados.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {channelLabel(c, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {conectados.length === 1 && (
                  <p className="text-sm text-muted-foreground">
                    {t("Número")} {channelLabel(conectados[0]!, t)}
                  </p>
                )}
              </>
            )}
            {/* Decisão do doc 158: a agenda do celular da empresa traz também
                família, fornecedores e gente que nunca falou com a empresa. A
                planilha exige exportar de propósito; aqui é um clique, então o
                aviso fica no caminho do clique, não escondido na descrição. */}
            <div
              role="note"
              className="flex items-start gap-2 rounded-md border border-warning-fg/30 bg-warning-bg p-3 text-sm"
            >
              <Warning size={18} weight="duotone" aria-hidden className="mt-0.5 shrink-0 text-warning-fg" />
              <p>
                {t(
                  "Isto traz todos os contatos salvos no celular, inclusive os pessoais. Só mande campanha a quem autorizou receber.",
                )}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sincronizar.isPending}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={!numero || sincronizar.isPending || canais.isLoading}>
                <ArrowsClockwise size={16} weight="bold" aria-hidden />
                <span>{sincronizar.isPending ? t("Sincronizando…") : t("Sincronizar")}</span>
              </Button>
            </DialogFooter>
          </form>
        )}

        {resumo && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md bg-surface px-2 py-1">
                {resumo.lidos} {t("lido(s) no aparelho")}
              </span>
              <span className="rounded-md px-2 py-1 font-medium">
                {resumo.importados} {t("importado(s)")}
              </span>
              {resumo.ja_existentes > 0 && (
                <span className="rounded-md bg-surface px-2 py-1">
                  {resumo.ja_existentes} {t("já existente(s)")}
                </span>
              )}
              {resumo.ignorados > 0 && (
                <span className="rounded-md bg-surface px-2 py-1">
                  {resumo.ignorados} {t("ignorado(s)")}
                </span>
              )}
              {resumo.erros > 0 && (
                <span className="rounded-md px-2 py-1 font-medium">{resumo.erros} {t("com erro")}</span>
              )}
            </div>
            {resumo.truncado && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "A sincronização bateu no teto de uma passada. Clique em Continuar de onde parou para seguir do próximo contato — o que já entrou não duplica.",
                )}
              </p>
            )}
            <DialogFooter>
              {continuar ? (
                <>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    {t("Concluir")}
                  </Button>
                  <Button type="button" onClick={sincronizarAgora} disabled={sincronizar.isPending}>
                    <ArrowsClockwise size={16} weight="bold" aria-hidden />
                    <span>
                      {sincronizar.isPending ? t("Sincronizando…") : t("Continuar de onde parou")}
                    </span>
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="ghost" onClick={reset}>
                    {t("Sincronizar de novo")}
                  </Button>
                  <Button type="button" onClick={() => onOpenChange(false)}>
                    {t("Concluir")}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
