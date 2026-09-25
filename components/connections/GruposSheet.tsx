"use client";
/**
 * Conexões › Grupos: quais grupos deste número aparecem na inbox. A rota
 * `GET/PUT /api/v1/channel-sessions/[id]/groups` já exige gerente+
 * (`requireRole("manager", ...)`); esta tela só monta atrás desse mesmo botão,
 * que `ConnectionsClient` só mostra dentro de `/app/connections` — página que
 * já barra quem é menos que admin (`app/app/connections/page.tsx`). Não há
 * segunda leitura de papel aqui: seria uma fonte paralela do mesmo dado.
 *
 * A IA nunca responde em grupo — o texto do cabeçalho diz isso, para que ligar
 * um grupo não pareça "a IA vai atender aqui também".
 *
 * Um número pode estar em 100+ grupos: a lista SEMPRE rola dentro do próprio
 * container (`overflow-y-auto` + `min-h-0 flex-1`), nunca a folha inteira —
 * cabeçalho, busca, contador e ações continuam visíveis. Sem isso, grupo além
 * da dobra do viewport era inalcançável.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

interface Grupo {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
  presente: boolean;
}

const AVISO_DE_VOLUME =
  "A partir de agora, o WhatsApp deste número passa a enviar mensagens de todos os grupos para o sistema. Só os grupos ligados aparecem no chat; os outros são descartados.";

const AVISO_DE_DESLIGAR_TODOS =
  "Todos os grupos ligados deste número vão parar de aparecer no chat, e o número vai parar de receber mensagens de grupo.";

const AVISO_DE_FAMILIA_AO_LIGAR_TODOS =
  "Grupos pessoais e de família desta lista também vão aparecer no chat. Use a busca para selecionar só os grupos de cliente antes de confirmar.";

/**
 * O PUT sequencial de "Desligar todos"/"Ligar todos" — mesmo loop para os
 * dois, extraído para não duplicar a regra: NUNCA em paralelo (o servidor
 * decide o filtro de grupo do WhatsApp contando linhas `enabled`, e duas
 * escritas concorrentes brigariam por essa contagem), para no primeiro erro.
 * Quem chama decide o `enabled` de destino e observa o progresso.
 */
async function executarPutEmLote(
  channelId: string,
  alvos: Grupo[],
  enabled: boolean,
  onProgresso: (atual: number, total: number) => void,
): Promise<{ concluidos: number; falhou: Grupo | null }> {
  let concluidos = 0;
  for (const g of alvos) {
    onProgresso(concluidos + 1, alvos.length);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_chat_id: g.chatId, subject: g.subject, enabled }),
    });
    if (!res.ok) return { concluidos, falhou: g };
    concluidos++;
  }
  return { concluidos, falhou: null };
}

/** Busca insensível a maiúscula/minúscula e a acento: "grupo sao" acha "Grupo São". */
function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function GruposSheet({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [grupos, setGrupos] = useState<Grupo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, setPendente] = useState<Grupo | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [confirmarDesligarTodos, setConfirmarDesligarTodos] = useState(false);
  const [confirmarLigarTodos, setConfirmarLigarTodos] = useState<{
    alvos: Grupo[];
    mostrarAvisoDeVolume: boolean;
  } | null>(null);
  const [progresso, setProgresso] = useState<{
    atual: number;
    total: number;
    acao: "ligar" | "desligar";
  } | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`);
    const j = (await res.json().catch(() => null)) as { data?: Grupo[] } | null;
    if (!res.ok || !j?.data) {
      setErro(
        res.status === 502
          ? t("O WhatsApp deste número não respondeu. Confira se ele está conectado e tente de novo.")
          : t("Não consegui ler os grupos deste número."),
      );
      return;
    }
    setGrupos(j.data);
  }, [channelId, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function gravar(g: Grupo, enabled: boolean) {
    setSalvando(g.chatId);
    setErro(null);
    const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_chat_id: g.chatId, subject: g.subject, enabled }),
    });
    setSalvando(null);
    if (!res.ok) {
      setErro(
        res.status === 502
          ? t("O WhatsApp não confirmou a mudança. Nada foi alterado; tente de novo.")
          : t("Não foi possível salvar."),
      );
      return;
    }
    setGrupos((atual) => atual?.map((x) => (x.chatId === g.chatId ? { ...x, enabled } : x)) ?? null);
  }

  function alternar(g: Grupo, enabled: boolean) {
    const nenhumLigado = !(grupos ?? []).some((x) => x.enabled);
    if (enabled && nenhumLigado) {
      setPendente(g);
      return;
    }
    void gravar(g, enabled);
  }

  /**
   * Desliga todos os grupos ligados. Sempre recarrega a lista do GET no fim,
   * sucesso ou não — a mensagem de falha (se houver) é só ARMADA antes do
   * reload e aplicada DEPOIS, senão o `carregar()` do `finally` (que limpa
   * `erro` no início) a apagaria antes de qualquer um vê-la.
   */
  async function desligarTodos() {
    const alvos = (grupos ?? []).filter((g) => g.enabled);
    setConfirmarDesligarTodos(false);
    setErro(null);
    setProgresso({ atual: 0, total: alvos.length, acao: "desligar" });
    let mensagemDeFalha: string | null = null;
    try {
      const { concluidos, falhou } = await executarPutEmLote(channelId, alvos, false, (atual, total) =>
        setProgresso({ atual, total, acao: "desligar" }),
      );
      if (falhou) {
        const rotulo = falhou.subject ?? t("Grupo sem nome");
        mensagemDeFalha = `${t("Não foi possível desligar todos os grupos.")} ${t("Falhou em")} "${rotulo}" ${t("depois de desligar")} ${concluidos}.`;
      }
    } finally {
      setProgresso(null);
      await carregar();
      if (mensagemDeFalha) setErro(mensagemDeFalha);
    }
  }

  /**
   * Liga todos os grupos VISÍVEIS (respeitando a busca) que ainda estão
   * desligados — nunca os já ligados nem os que a busca escondeu. Mesma
   * regra de `desligarTodos`: sequencial, para no primeiro erro, sempre
   * recarrega no fim. O aviso de volume (quando nenhum grupo estava ligado
   * ainda) já foi mostrado na confirmação; não repete durante o loop.
   */
  async function ligarTodos(alvos: Grupo[]) {
    setConfirmarLigarTodos(null);
    setErro(null);
    setProgresso({ atual: 0, total: alvos.length, acao: "ligar" });
    let mensagemDeFalha: string | null = null;
    try {
      const { concluidos, falhou } = await executarPutEmLote(channelId, alvos, true, (atual, total) =>
        setProgresso({ atual, total, acao: "ligar" }),
      );
      if (falhou) {
        const rotulo = falhou.subject ?? t("Grupo sem nome");
        mensagemDeFalha = `${t("Não foi possível ligar todos os grupos.")} ${t("Falhou em")} "${rotulo}" ${t("depois de ligar")} ${concluidos}.`;
      }
    } finally {
      setProgresso(null);
      await carregar();
      if (mensagemDeFalha) setErro(mensagemDeFalha);
    }
  }

  const ligados = (grupos ?? []).filter((g) => g.enabled).length;
  const total = grupos?.length ?? 0;

  const filtrados = useMemo(() => {
    const alvo = normalizarBusca(busca);
    return (grupos ?? []).filter((g) =>
      normalizarBusca(g.subject ?? t("Grupo sem nome")).includes(alvo),
    );
  }, [grupos, busca, t]);

  // "Ligar todos" age sempre sobre os VISÍVEIS (respeitando a busca) que
  // ainda estão desligados — nunca sobre um já ligado nem sobre um que a
  // busca escondeu.
  const alvosParaLigar = useMemo(() => filtrados.filter((g) => !g.enabled), [filtrados]);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex h-full w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("Grupos")}</SheetTitle>
          <SheetDescription>
            {t(
              "Grupos ligados aparecem no chat para os atendentes responderem. A IA nunca responde em grupo.",
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 pb-2 pt-3">
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => void carregar()}>
              {t("Atualizar lista")}
            </Button>
            <div className="flex items-center gap-2">
              {alvosParaLigar.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={progresso !== null}
                  onClick={() =>
                    setConfirmarLigarTodos({ alvos: alvosParaLigar, mostrarAvisoDeVolume: ligados === 0 })
                  }
                >
                  {busca === "" ? (
                    t("Ligar todos")
                  ) : (
                    <>
                      {t("Ligar os")} {alvosParaLigar.length} {t("do filtro")}
                    </>
                  )}
                </Button>
              )}
              {ligados >= 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={progresso !== null}
                  onClick={() => setConfirmarDesligarTodos(true)}
                >
                  {t("Desligar todos")}
                </Button>
              )}
            </div>
          </div>

          {grupos && (
            <p className="text-sm text-muted-foreground">
              {ligados} {t("de")} {total} {t("ligados")}
            </p>
          )}

          {progresso && (
            <p className="text-xs text-muted-foreground" role="status">
              {progresso.acao === "ligar" ? t("Ligando") : t("Desligando")} {progresso.atual}{" "}
              {t("de")} {progresso.total}
            </p>
          )}

          {erro && (
            <p role="alert" className="text-sm text-destructive">
              {erro}
            </p>
          )}

          {pendente && (
            <div role="alertdialog" className="rounded-md border p-3 text-sm">
              <p>{t(AVISO_DE_VOLUME)}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    const g = pendente;
                    setPendente(null);
                    void gravar(g, true);
                  }}
                >
                  {t("Ligar mesmo assim")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPendente(null)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          )}

          {confirmarDesligarTodos && (
            <div role="alertdialog" className="rounded-md border p-3 text-sm">
              <p>{t(AVISO_DE_DESLIGAR_TODOS)}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void desligarTodos()}>
                  {t("Desligar todos mesmo assim")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmarDesligarTodos(false)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          )}

          {confirmarLigarTodos && (
            <div role="alertdialog" className="rounded-md border p-3 text-sm">
              <p>
                {confirmarLigarTodos.alvos.length} {t("grupos vão ligar e aparecer no chat.")}
              </p>
              <p>{t(AVISO_DE_FAMILIA_AO_LIGAR_TODOS)}</p>
              {confirmarLigarTodos.mostrarAvisoDeVolume && <p>{t(AVISO_DE_VOLUME)}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void ligarTodos(confirmarLigarTodos.alvos)}>
                  {t("Ligar todos mesmo assim")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmarLigarTodos(null)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          )}

          {grupos && grupos.length > 0 && (
            <Input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar grupo")}
              aria-label={t("Buscar grupo")}
            />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="space-y-2">
            {filtrados.map((g) => (
              <li key={g.chatId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm">{g.subject ?? t("Grupo sem nome")}</span>
                  {!g.presente && (
                    <p className="text-xs text-muted-foreground">
                      {t("O número saiu deste grupo. Desligue a chave se não precisar mais dela.")}
                    </p>
                  )}
                </div>
                <Switch
                  aria-label={g.subject ?? t("Grupo sem nome")}
                  checked={g.enabled}
                  disabled={salvando === g.chatId || progresso !== null}
                  onCheckedChange={(v) => alternar(g, v)}
                />
              </li>
            ))}
          </ul>
          {grupos?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("Este número não está em nenhum grupo.")}
            </p>
          )}
          {grupos && grupos.length > 0 && filtrados.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("Nenhum grupo encontrado")}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
