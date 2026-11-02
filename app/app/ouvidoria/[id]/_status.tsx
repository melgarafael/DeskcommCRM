"use client";

/**
 * MUDAR O STATUS DA MANIFESTAÇÃO (#3611, fatia 3) — o único controle de escrita
 * da tela de gestão.
 *
 * ─── O que este componente NÃO decide ─────────────────────────────────────
 *
 * Quais transições existem, e quais exigem motivo. Isso é do servidor: as
 * `opcoes` chegam prontas de `lib/ouvidoria/transicao.ts` (`proximosStatus`), e
 * a action confere de novo. Aqui só se desenha o que foi oferecido — de
 * propósito, porque um botão a mais seria uma promessa que a action recusaria, e
 * um botão a menos esconderia uma reabertura legítima.
 *
 * ─── Por que `import type` e nada mais de `lib/ouvidoria` ─────────────────
 *
 * `lib/ouvidoria/registro.ts` importa `node:crypto` para gerar o protocolo. Um
 * import de VALOR daquele módulo arrastaria `node:crypto` para o bundle do
 * navegador e a tela morreria no build. Os tipos somem na compilação; os dados
 * chegam por prop.
 *
 * ─── O motivo é obrigatório só na reabertura ─────────────────────────────
 *
 * O campo aparece quando o destino é `reabertura: true` e é exigido pelo
 * servidor (`motivo_obrigatorio`). Avançar não pede motivo: o motivo é sobre
 * DESFAZER um encerramento — é o controle que a issue pede ("`concluida` não
 * volta para `recebida` sem motivo") e o que a trilha de auditoria guarda.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { mudarStatusDaManifestacao } from "@/app/actions/ouvidoria/mudar-status-manifestacao";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { StatusDaOuvidoria } from "@/lib/ouvidoria/registro";

const STATUS_ROTULO: Record<StatusDaOuvidoria, string> = {
  recebida: "Recebida",
  em_analise: "Em análise",
  concluida: "Concluída",
};

/**
 * A recusa da action, em frase. Cada código tem a sua: "não foi possível
 * salvar" para tudo faria quem opera tentar de novo o que nunca vai passar
 * (motivo curto, etapa pulada).
 *
 * Recebe o `t` por parâmetro, e não o captura do módulo: assim cada frase passa
 * pela tradução na origem (o guarda de i18n enxerga `t("…")` literal) e não há
 * um `t(variavel)` no JSX, que é o desenho que o mesmo guarda proíbe.
 */
function mensagemDoErro(codigo: string, t: (texto: string) => string): string {
  switch (codigo) {
    case "mesmo_status":
      return t("Este já é o status da manifestação.");
    case "salto_de_etapa":
      return t("Não é possível pular a etapa de análise.");
    case "motivo_obrigatorio":
      return t("Escreva o motivo da reabertura.");
    case "motivo_longo_demais":
      return t("O motivo está longo demais.");
    case "conflito":
      return t("A manifestação mudou enquanto você decidia. Recarregue a página.");
    case "not_found":
      return t("Manifestação não encontrada.");
    case "unauthenticated":
    case "forbidden_tenant":
    case "forbidden_role":
      return t("Sem permissão para mudar o status.");
    default:
      return t("Não foi possível salvar o status.");
  }
}

export function MudarStatus({
  id,
  de,
  opcoes,
}: {
  id: string;
  de: StatusDaOuvidoria;
  opcoes: Array<{ para: StatusDaOuvidoria; reabertura: boolean }>;
}) {
  const t = useT();
  const router = useRouter();
  const [escolhido, setEscolhido] = useState<StatusDaOuvidoria | null>(null);
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const opcao = opcoes.find((o) => o.para === escolhido) ?? null;
  const precisaDeMotivo = opcao?.reabertura === true;

  async function submeter() {
    if (!escolhido || enviando) return;
    setEnviando(true);
    setErro(null);
    setSalvo(false);

    const resultado = await mudarStatusDaManifestacao({
      id,
      status: escolhido,
      motivo: precisaDeMotivo ? motivo : undefined,
    });

    setEnviando(false);

    if (!resultado.ok) {
      setErro(mensagemDoErro(resultado.error, t));
      return;
    }

    setSalvo(true);
    setEscolhido(null);
    setMotivo("");
    // A página é Server Component: sem isto o selo de status continuaria com o
    // valor antigo até um recarregamento completo.
    router.refresh();
  }

  if (opcoes.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          {t("Não há outra etapa para esta manifestação.")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t("Mudar status")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Status atual")}: {t(STATUS_ROTULO[de] ?? de)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {opcoes.map((o) => (
          <Button
            key={o.para}
            type="button"
            size="sm"
            variant={escolhido === o.para ? "default" : "outline"}
            className="text-xs"
            aria-pressed={escolhido === o.para}
            onClick={() => {
              setEscolhido(o.para);
              setSalvo(false);
              setErro(null);
            }}
          >
            {t(STATUS_ROTULO[o.para] ?? o.para)}
          </Button>
        ))}
      </div>

      {precisaDeMotivo && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t("Motivo da mudança")}</span>
          <textarea
            className="min-h-[72px] w-full rounded-md border border-border bg-background p-2 text-sm"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={t("Explique por que a manifestação está sendo reaberta.")}
          />
        </label>
      )}

      {escolhido && (
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" disabled={enviando} onClick={submeter}>
            {enviando ? t("Salvando…") : t("Salvar")}
          </Button>
          {salvo && (
            <span role="status" className="text-xs text-muted-foreground">
              {t("Status atualizado.")}
            </span>
          )}
        </div>
      )}

      {erro && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {erro}
        </p>
      )}
    </Card>
  );
}
