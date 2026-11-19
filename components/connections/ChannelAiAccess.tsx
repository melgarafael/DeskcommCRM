"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { useT } from "@/hooks/i18n/useT";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { apiClient } from "@/lib/api/client";
import { aiAccessUpdateSchema, type AiAccessMode } from "@/lib/ai/elegibilidade/pre-go-live";

interface SocialCandidate { social_identity: string; name: string | null }
interface Access {
  mode: AiAccessMode;
  test_phone_numbers: string[];
  /** Ausente em resposta de servidor anterior a esta lista: tratado como vazio. */
  test_social_identities?: string[];
  /** Só vem quando o painel pede `?candidatos=sociais`. */
  social_candidates?: SocialCandidate[];
}

/**
 * "Instagram · …361506": a rede e o fim do id do participante, para distinguir
 * dois contatos com o mesmo nome sem expor o id inteiro na tela.
 */
function rotuloDaIdentidade(identidade: string): string {
  const [rede = "", , participante = ""] = identidade.split(":");
  const nome = rede === "instagram" ? "Instagram" : rede === "facebook" ? "Facebook" : rede;
  return `${nome} · …${participante.slice(-6)}`;
}

/**
 * Mesma porta em todos os tipos de conexão; telefones e contas de teste
 * acessíveis só a administradores. `socialTesting` (Instagram/Facebook): o
 * modo de teste libera a IA só para contas escolhidas entre os contatos do canal.
 */
export function ChannelAiAccess({ channelId, phoneTesting = true, socialTesting = false }: { channelId: string; phoneTesting?: boolean; socialTesting?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: socialTesting ? ["channel-ai-access", channelId, "sociais"] : ["channel-ai-access", channelId],
    queryFn: () => apiClient.get<{ data: Access }>(`/api/v1/channel-sessions/${channelId}/ai-access${socialTesting ? "?candidatos=sociais" : ""}`),
    refetchOnWindowFocus: !open,
  });
  const mode = query.data?.data.mode;
  const contasDeTeste = query.data?.data.test_social_identities?.length ?? 0;
  // Canal social com conta de teste está EM TESTE, não pausado: a IA responde a alguém.
  const emTeste = phoneTesting || (socialTesting && contasDeTeste > 0);
  return (
    <div className="flex flex-col items-start gap-2">
      {mode && <Badge variant={mode === "open" ? "neutral" : "warning"}>
        {mode === "pre_go_live" ? (emTeste ? t("IA em modo de teste") : t("IA pausada")) : mode === "open" ? t("IA aberta ao público") : t("IA restrita por origem")}
      </Badge>}
      {/* A frase inteira por número, e não `${n} ${t("números…")}` montado por
          pedaços: com um único testador o cartão dizia "1 números de teste
          autorizados" — achado olhando a tela, que é o único jeito de achar
          concordância. E montar por pedaços não sobrevive à tradução: em
          espanhol a forma muda junto. Lista vazia é o estado inicial de todo
          canal novo e merece a frase que diz o que fazer, não um "0". */}
      {mode === "pre_go_live" && <p className="text-xs text-muted-foreground">
        {(() => {
          if (socialTesting && contasDeTeste > 0) {
            return contasDeTeste === 1 ? t("1 conta de teste autorizada") : `${contasDeTeste} ${t("contas de teste autorizadas")}`;
          }
          if (!phoneTesting) return t("As mensagens chegam para atendimento humano. A IA está pausada neste canal.");
          const n = query.data?.data.test_phone_numbers.length ?? 0;
          if (n === 0) return t("Nenhum número autorizado — a IA não responde ninguém neste canal.");
          if (n === 1) return t("1 número de teste autorizado");
          return `${n} ${t("números de teste autorizados")}`;
        })()}
      </p>}
      <Button variant="outline" size="sm" onClick={() => { setOpen(true); void query.refetch(); }}>
        {t("Configurar acesso da IA")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{(phoneTesting ? t("Acesso da IA no WhatsApp") : t("Acesso da IA nesta rede"))}</SheetTitle>
            <SheetDescription>{phoneTesting ? t("Teste com pessoas de confiança antes de liberar o atendimento automático.") : t("Pause a IA para manter o atendimento humano ou libere as respostas automáticas neste canal.")}</SheetDescription>
          </SheetHeader>
          {query.isFetching ? <p role="status">{t("Carregando…")}</p> : query.isError ? (
            <div className="flex flex-col gap-3" role="alert">
              <p>{t("Não foi possível carregar o acesso da IA.")}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button>
            </div>
          ) : open && query.data ? (
            <AccessForm phoneTesting={phoneTesting} socialTesting={socialTesting} channelId={channelId} initial={query.data.data} onClose={() => setOpen(false)} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AccessForm({ channelId, initial, onClose, phoneTesting, socialTesting }: { channelId: string; initial: Access; onClose: () => void; phoneTesting: boolean; socialTesting: boolean }) {
  const t = useT();
  const telefoneExemplo = useTelefoneExemplo();
  const id = useId();
  const qc = useQueryClient();
  const [numbers, setNumbers] = useState(initial.test_phone_numbers.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [contas, setContas] = useState<string[]>(initial.test_social_identities ?? []);
  const candidatos = initial.social_candidates ?? [];
  const alternarConta = (identidade: string) => {
    setError(null);
    setContas(atual => atual.includes(identidade) ? atual.filter(i => i !== identidade) : [...atual, identidade]);
  };

  async function save(mode: "open" | "pre_go_live") {
    const parsed = aiAccessUpdateSchema.safeParse({
      mode, test_phone_numbers: phoneTesting ? numbers.split("\n").map(n => n.trim()).filter(Boolean) : [],
      // Só o painel social manda a lista social: ausente, a gravada fica como está.
      ...(socialTesting ? { test_social_identities: contas } : {}),
    });
    if (!parsed.success) {
      // O exemplo é o do país da organização, não um celular brasileiro escrito na frase.
      // No painel social não há telefone: as contas vêm da própria lista do canal.
      if (!phoneTesting) { setError(t("Não foi possível confirmar o salvamento. Reabra este painel para conferir a configuração.")); return; }
      setError(t("Use um telefone com DDI por linha, por exemplo {exemplo}.").replace("{exemplo}", () => telefoneExemplo));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await apiClient.patch<{ data: Access }>(`/api/v1/channel-sessions/${channelId}/ai-access`, parsed.data);
      qc.setQueryData(["channel-ai-access", channelId], saved);
      if (socialTesting) await qc.invalidateQueries({ queryKey: ["channel-ai-access", channelId, "sociais"] });
      toast.success(t("Acesso da IA atualizado."));
      onClose();
    } catch {
      setError(t("Não foi possível confirmar o salvamento. Reabra este painel para conferir a configuração."));
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Badge variant={initial.mode === "open" ? "neutral" : "warning"}>
          {initial.mode === "pre_go_live" ? ((phoneTesting || (socialTesting && (initial.test_social_identities?.length ?? 0) > 0)) ? t("IA em modo de teste") : t("IA pausada")) : initial.mode === "open" ? t("IA aberta ao público") : t("IA restrita por origem")}
        </Badge>
        <p className="text-sm text-muted-foreground">
          {socialTesting ? t("Somente as contas marcadas abaixo podem receber respostas automáticas enquanto o canal está em teste. Sem nenhuma marcada, a IA fica pausada.") : !phoneTesting ? t("Pause a IA para manter o atendimento humano ou libere as respostas automáticas neste canal.") : initial.mode === "pre_go_live"
            ? t("Somente os números desta lista podem receber respostas automáticas neste canal.")
            : initial.mode === "open"
              ? t("A lista de teste não restringe o atendimento enquanto a IA está aberta ao público.")
              : t("Este canal usa autorizações por origem. Ativar o modo de teste substitui essa regra pela lista abaixo.")}
        </p>
      </div>
      {phoneTesting && <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t("Números autorizados para teste")}</Label>
        <Textarea id={id} rows={6} value={numbers} disabled={busy}
          onChange={e => { setNumbers(e.target.value); setError(null); }}
          aria-invalid={Boolean(error)} aria-describedby={`${id}-help`}
          placeholder={telefoneExemplo} />
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {t("Um telefone com DDI por linha. Lista vazia no modo de teste bloqueia todas as respostas automáticas.")}
        </p>
      </div>}
      {socialTesting && <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("Contas autorizadas para teste")}</legend>
        {candidatos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhum contato desta rede conversou com o canal ainda. Peça para a conta de teste mandar uma mensagem e reabra este painel.")}
          </p>
        ) : candidatos.map(c => {
          const marcado = contas.includes(c.social_identity);
          return (
            <label key={c.social_identity}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${marcado ? "border-primary bg-primary/5" : ""}`}>
              <input type="checkbox" checked={marcado} disabled={busy}
                onChange={() => alternarConta(c.social_identity)} className="accent-current" />
              <span className="flex flex-col">
                <span>{c.name ?? t("Sem nome")}</span>
                <span className="text-xs text-muted-foreground">{rotuloDaIdentidade(c.social_identity)}</span>
              </span>
            </label>
          );
        })}
      </fieldset>}
      <p className="text-sm text-muted-foreground">
        {phoneTesting ? t("As mensagens continuam chegando ao Inbox, e sua equipe pode responder manualmente. Os testes são mensagens reais no WhatsApp, com os custos normais de uso.") : t("As mensagens continuam chegando à caixa de entrada para sua equipe responder. Confira outras automações da conta antes de liberar a IA aqui.")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("O agente precisa estar publicado e vinculado a este canal. Bloqueios do contato e atendimento humano continuam sendo respeitados.")}
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save("pre_go_live")}>
          {busy ? t("Salvando…") : socialTesting && contas.length > 0 ? t("Salvar contas de teste") : !phoneTesting ? t("Pausar respostas da IA") : initial.mode === "pre_go_live" ? t("Salvar lista de teste") : t("Ativar modo de teste")}
        </Button>
        {initial.mode !== "open" && <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(true)}>
          {t("Liberar atendimento ao público")}
        </Button>}
        <Button variant="ghost" disabled={busy} onClick={onClose}>{t("Cancelar")}</Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Liberar a IA para o público?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("A lista de teste deixará de limitar as respostas. A IA poderá atender qualquer pessoa que enviar mensagem neste canal, respeitando os demais bloqueios.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{phoneTesting ? t("Continuar em teste") : t("Manter IA pausada")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save("open")}>{t("Confirmar liberação")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
