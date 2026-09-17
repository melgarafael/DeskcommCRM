"use client";

/**
 * O painel da tela de Tags: a lista do vocabulário com o PESO de cada etiqueta e
 * as três operações (issue #852, fatia S4).
 *
 * ── Por que cada linha abre com os números, e não com o botão ───────────────
 *
 * A pergunta que traz o operador até aqui é "posso mexer nesta?". A resposta é o
 * número: quantos contatos, leads e conversas carregam a etiqueta, e quantas
 * regras de agente ainda escrevem esse nome. A coluna de regras é a que a lista
 * de conversas nunca mostrava — foi ela que deixou a grafia antiga voltar depois
 * da "arrumação".
 *
 * ── Por que excluir pede confirmação e renomear não ─────────────────────────
 *
 * Renomear é reversível: o nome novo aparece na lista e dá para voltar. Excluir
 * tira a etiqueta de todos os registros da organização e não existe desfazer —
 * então a confirmação diz exatamente o que sai, com o número na frente. As
 * regras `add_tag` NÃO são apagadas pela exclusão (decisão de outra tela, com o
 * runbook do agente na mão); o aviso informa quantas continuam escrevendo.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { AcaoDeVocabulario, LinhaDeVocabulario } from "@/lib/schemas/tags";

/**
 * O TETO DA LISTA, e por que ele é declarado aqui.
 *
 * `fn_vocabulario_de_tags` termina em `limit 500` (migration 0264). A rota
 * devolve `meta.total = tags.length`, que é o tamanho da PÁGINA e não o total —
 * então nem o `meta` denuncia o corte. Sem esta linha, numa organização com mais
 * de 500 etiquetas distintas a que o operador veio arrumar podia simplesmente
 * não estar na tela, nem na lista de destinos do "juntar", sem nada dizendo que
 * faltava alguma. Lista truncada em silêncio lê como lista completa.
 *
 * O número vive nos DOIS arquivos e é vigiado por
 * `tests/unit/tags-vocabulario.test.ts` ("o teto da tela é o mesmo `limit` do
 * SQL"), que lê o `limit` da migration e esta constante: mudar um sem o outro
 * reprova.
 */
const TETO_DA_LISTA = 500;

/** Cada recusa do servidor vira uma frase que diz O QUE FAZER. */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira a etiqueta e o novo nome.",
  forbidden: "Só um gerente ou administrador da organização pode mudar as etiquetas.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  mfa_required: "Confirme o segundo fator para mudar as etiquetas.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
};

export function PainelDeTags({ tags, idioma }: { tags: LinhaDeVocabulario[]; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [alvo, setAlvo] = useState<LinhaDeVocabulario | null>(null);
  const [acao, setAcao] = useState<AcaoDeVocabulario>("renomear");
  const [destino, setDestino] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const destinos = useMemo(
    () => tags.filter((linha) => linha.tag.toLowerCase() !== alvo?.tag.toLowerCase()),
    [tags, alvo],
  );

  function abrir(linha: LinhaDeVocabulario, qual: AcaoDeVocabulario) {
    setAlvo(linha);
    setAcao(qual);
    setDestino("");
  }

  async function enviar() {
    if (!alvo) return;
    setOcupado(true);
    try {
      const resposta = await fetch("/api/v1/tags/vocabulario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao, tag: alvo.tag, destino: destino || null }),
      });
      const corpo = (await resposta.json().catch(() => null)) as
        | { data?: Record<string, number | string | boolean | null>; error?: { code?: string } }
        | null;
      if (!resposta.ok) {
        const codigo = corpo?.error?.code ?? "internal_error";
        toast.error(t(ERRO_EM_PORTUGUES[codigo] ?? "Não foi possível concluir agora. Tente de novo."));
        return;
      }
      const dados = corpo?.data ?? {};
      const alterados =
        Number(dados.contatos ?? 0) + Number(dados.leads ?? 0) + Number(dados.conversas ?? 0);
      // ⚠️ O DADO ENTRA FORA DO `t()`. `traduzir()` casa a string EXATA, então
      // uma frase montada em runtime nunca casa chave nenhuma —
      // a frase sai em português para quem escolheu espanhol, e o guarda de i18n
      // não acusa (ele só registra literal sem substituição).
      toast.success(
        acao === "excluir"
          ? `${t("Etiqueta removida de")} ${alterados} ${t("registro(s).")}`
          : `${t("Etiqueta atualizada em")} ${alterados} ${t("registro(s) e em")} ${Number(dados.regras ?? 0)} ${t("regra(s) de agente.")}`,
      );
      setAlvo(null);
      router.refresh();
    } catch {
      // Sem este ramo, uma falha de REDE (app reiniciando, conexão caída) não
      // dizia nada: o botão voltava de "Aplicando..." para "Confirmar", que lê
      // como "nada aconteceu" — enquanto a operação pode ter sido aplicada no
      // servidor. O caminho de erro do SERVIDOR já era tratado acima.
      toast.error(
        t("Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo."),
      );
    } finally {
      setOcupado(false);
    }
  }

  if (tags.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t(
          "Nenhuma etiqueta nesta organização ainda. Elas aparecem aqui conforme os agentes, o Inbox e o funil usarem.",
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("Etiquetas da organização e onde são usadas")}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-3 font-medium">{t("Etiqueta")}</th>
              <th className="p-3 font-medium">{t("Contatos")}</th>
              <th className="p-3 font-medium">{t("Leads")}</th>
              <th className="p-3 font-medium">{t("Conversas")}</th>
              <th className="p-3 font-medium">{t("Regras de agente")}</th>
              <th className="p-3 font-medium">{t("Ações")}</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((linha) => (
              <tr key={linha.tag} className="border-t border-border/60">
                <td className="p-3">
                  <span className="font-medium">{linha.tag}</span>
                  {!linha.no_vocabulario && (
                    // Em uso e fora do vocabulário curado: existe em algum
                    // registro sem passar por nenhuma tela de cadastro.
                    <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("em uso, fora do vocabulário")}
                    </span>
                  )}
                </td>
                <td className="p-3 tabular-nums">{linha.uso_em_contatos}</td>
                <td className="p-3 tabular-nums">{linha.uso_em_leads}</td>
                <td className="p-3 tabular-nums">{linha.uso_em_conversas}</td>
                <td className="p-3 tabular-nums">
                  {linha.em_regras > 0 ? (
                    <span className="font-medium">{linha.em_regras}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="flex flex-wrap gap-2 p-3">
                  <Button size="sm" variant="outline" onClick={() => abrir(linha, "renomear")}>
                    {t("Renomear")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => abrir(linha, "juntar")}>
                    {t("Juntar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => abrir(linha, "excluir")}>
                    {t("Excluir")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tags.length >= TETO_DA_LISTA && (
          <p className="border-t border-border/60 p-3 text-sm text-muted-foreground">
            {t(
              "Mostrando as 500 primeiras etiquetas em ordem alfabética. Se a que você procura não está aqui, arrume primeiro as que aparecem.",
            )}
          </p>
        )}
      </Card>

      {alvo && (
        <Card className="flex flex-col gap-4 p-4">
          <p className="text-sm">
            {/* Mesma regra do toast: o texto estático passa por `t()`, a
                etiqueta entra fora dele. */}
            {acao === "renomear" && (
              <>
                {t("Renomear")} <strong>{alvo.tag}</strong> {t("para:")}
              </>
            )}
            {acao === "juntar" && (
              <>
                {t("Juntar")} <strong>{alvo.tag}</strong> {t("em outra etiqueta existente:")}
              </>
            )}
            {acao === "excluir" && (
              <>
                {t("Excluir")} <strong>{alvo.tag}</strong> {t("de")} {alvo.uso_em_contatos}{" "}
                {t("contato(s),")} {alvo.uso_em_leads} {t("lead(s) e")} {alvo.uso_em_conversas}{" "}
                {t("conversa(s).")}
              </>
            )}
          </p>

          {acao === "excluir" ? (
            alvo.em_regras > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                {t("Atenção:")} {alvo.em_regras}{" "}
                {t(
                  "regra(s) de agente continuam escrevendo esta etiqueta. Excluir aqui não apaga a regra — o agente vai recriar a etiqueta no próximo atendimento.",
                )}
              </p>
            )
          ) : acao === "juntar" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="destino-da-juncao">{t("Etiqueta de destino")}</Label>
              <select
                id="destino-da-juncao"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={destino}
                onChange={(evento) => setDestino(evento.target.value)}
              >
                <option value="">{t("Escolha a etiqueta que fica")}</option>
                {destinos.map((linha) => (
                  <option key={linha.tag} value={linha.tag}>
                    {linha.tag}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="novo-nome-da-tag">{t("Novo nome")}</Label>
              <Input
                id="novo-nome-da-tag"
                value={destino}
                onChange={(evento) => setDestino(evento.target.value)}
                maxLength={60}
                placeholder={alvo.tag}
              />
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={enviar}
              disabled={ocupado || (acao !== "excluir" && destino.trim().length === 0)}
              variant={acao === "excluir" ? "destructive" : "default"}
            >
              {ocupado ? t("Aplicando...") : t("Confirmar")}
            </Button>
            <Button variant="ghost" onClick={() => setAlvo(null)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
