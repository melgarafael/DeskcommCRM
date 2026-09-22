"use client";
import * as React from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";
import { NexusSteps } from "@/components/nexus-ui/forms/NexusSteps";
import { NexusAiBriefing, type NexusInsight } from "@/components/nexus-ui/ai/NexusAi";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api/client";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import type { MacroCategoria } from "@/lib/prospeccao/categorias";

interface CidadeAlvo {
  cidade: string;
  estado?: string;
}

interface EstimativaCidade {
  rotulo: string;
  empresas: number;
  clientes: number;
  potencial: number;
}

interface ResultadoExecucao {
  buscas: number;
  sem_mapa: string[];
}

function parseCidades(texto: string): CidadeAlvo[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const partes = l.split("/").map((s) => s.trim());
      const cidade = partes[0] ?? "";
      const estado = partes[1];
      return { cidade, ...(estado ? { estado: estado.toUpperCase() } : {}) };
    })
    .filter((c) => c.cidade.length > 0);
}

/**
 * Wizard de campanha (FASE 8): Segmentação → Público → Mensagem → Aprovação →
 * Resultado. Cria e executa a MESMA campanha de descoberta (POST + executar);
 * nada de envio em massa inventado — a mensagem é de abordagem manual, com
 * preview interpolado, e a execução só sai com aprovação explícita.
 */
export function CampanhaWizard({
  categorias,
  aoConcluir,
}: {
  categorias: MacroCategoria[];
  aoConcluir: () => void;
}) {
  const t = useT();
  const PASSOS = [t("Segmentação"), t("Público"), t("Mensagem"), t("Aprovação"), t("Resultado")];

  const [passo, setPasso] = React.useState(0);
  const [alcancado, setAlcancado] = React.useState(0);
  const [nome, setNome] = React.useState("");
  const [marcadas, setMarcadas] = React.useState<string[]>([]);
  const [cidadesTexto, setCidadesTexto] = React.useState("");
  const [recorrencia, setRecorrencia] = React.useState("");
  const [templateId, setTemplateId] = React.useState("__nenhum");
  const [mensagemLivre, setMensagemLivre] = React.useState("");
  const [aprovado, setAprovado] = React.useState(false);
  const [ocupado, setOcupado] = React.useState(false);
  const [resultado, setResultado] = React.useState<ResultadoExecucao | null>(null);

  const templates = useMessageTemplates();
  const cidades = React.useMemo(() => parseCidades(cidadesTexto), [cidadesTexto]);

  const [estimativas, setEstimativas] = React.useState<{
    chave: string;
    dados: EstimativaCidade[];
  } | null>(null);

  const chaveCidades = cidades.map((c) => `${c.cidade}/${c.estado ?? ""}`).join("|");
  const estimando = passo === 1 && cidades.length > 0 && estimativas?.chave !== chaveCidades;

  // Estimativa de público: mercado real por cidade (empresas, clientes, potencial).
  // Sem setState no corpo do efeito: a chave identifica o pedido e o loading
  // deriva dela — sem cascata de renders.
  React.useEffect(() => {
    if (passo !== 1 || cidades.length === 0) return;
    const chave = cidades.map((c) => `${c.cidade}/${c.estado ?? ""}`).join("|");
    let vivo = true;
    (async () => {
      try {
        const partes = await Promise.all(
          cidades.slice(0, 5).map(async (c) => {
            const corpo = await apiClient.get<{
              data: { totais: { empresas: number; clientes_vinculados: number } };
            }>(`/api/v1/prospecting/mercado?cidade=${encodeURIComponent(c.cidade)}`);
            const tot = corpo.data.totais;
            return {
              rotulo: c.estado ? `${c.cidade}/${c.estado}` : c.cidade,
              empresas: tot.empresas,
              clientes: tot.clientes_vinculados,
              potencial: Math.max(0, tot.empresas - tot.clientes_vinculados),
            };
          }),
        );
        if (vivo) setEstimativas({ chave, dados: partes });
      } catch {
        if (vivo) setEstimativas({ chave, dados: [] });
      }
    })();
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passo, chaveCidades]);

  function ir(prox: number) {
    setPasso(prox);
    setAlcancado((a) => Math.max(a, prox));
  }

  function continuar() {
    if (passo === 0) {
      if (nome.trim().length < 2 || marcadas.length === 0 || cidades.length === 0) {
        nexusToast.error(
          t("Nome, ao menos 1 categoria e ao menos 1 cidade (uma por linha, Cidade/UF)."),
        );
        return;
      }
    }
    ir(Math.min(PASSOS.length - 1, passo + 1));
  }

  const template = (templates.data ?? []).find((x) => x.id === templateId) ?? null;
  const mensagemFinal = mensagemLivre.trim() || template?.body || "";
  const preview = mensagemFinal ? interpolateTemplate(mensagemFinal, { name: "Maria Silva" }) : "";

  const dadosEstimativa = estimativas?.chave === chaveCidades ? estimativas.dados : null;

  const insights = React.useMemo<NexusInsight[]>(() => {
    if (!dadosEstimativa || dadosEstimativa.length === 0) return [];
    const top = [...dadosEstimativa].sort((a, b) => b.potencial - a.potencial)[0]!;
    if (top.potencial === 0) return [];
    return [
      {
        id: "potencial",
        text: `${top.rotulo} ${t("concentra o maior potencial")}: ${top.potencial} ${t("empresas ainda não clientes.")}`,
      },
    ];
  }, [dadosEstimativa, t]);

  async function criarEExecutar() {
    if (!aprovado) {
      nexusToast.error(t("Marque a aprovação para executar."));
      return;
    }
    setOcupado(true);
    try {
      const criada = await apiClient.post<{ data: { id: string } }>(
        "/api/v1/prospecting/campaigns",
        {
          nome: nome.trim(),
          categorias: marcadas,
          cidades,
          ...(recorrencia ? { recorrencia_dias: Number(recorrencia) } : {}),
        },
      );
      const corpo = await apiClient.post<{ data: { buscas: number; sem_mapa: string[] } | null }>(
        `/api/v1/prospecting/campaigns/${criada.data.id}/executar`,
        {},
      );
      const r = corpo?.data ?? { buscas: 0, sem_mapa: [] as string[] };
      setResultado({ buscas: r.buscas, sem_mapa: r.sem_mapa ?? [] });
      nexusToast.success(`${r.buscas} ${t("buscas criadas")}`);
      aoConcluir();
      ir(4);
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  function recomeçar() {
    setPasso(0);
    setAlcancado(0);
    setNome("");
    setMarcadas([]);
    setCidadesTexto("");
    setRecorrencia("");
    setTemplateId("__nenhum");
    setMensagemLivre("");
    setAprovado(false);
    setResultado(null);
  }

  const opcoes = categorias.flatMap((m) =>
    m.subcategorias.map((s) => ({ ...s, chave: `${m.macro}:${s.busca}` })),
  );

  return (
    <Card className="space-y-4 p-4">
      <NexusSteps steps={PASSOS} current={passo} reached={alcancado} onGo={setPasso} />

      {passo === 0 && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wiz-nome">{t("Nome da campanha")}</Label>
            <Input
              id="wiz-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Oficinas — Norte SC"
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">{t("Categorias")}</p>
            <div className="flex flex-wrap gap-2">
              {opcoes.map((s) => (
                <label
                  key={s.chave}
                  className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${
                    marcadas.includes(s.busca)
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={marcadas.includes(s.busca)}
                    onChange={() =>
                      setMarcadas((mm) =>
                        mm.includes(s.busca) ? mm.filter((x) => x !== s.busca) : [...mm, s.busca],
                      )
                    }
                  />
                  {s.rotulo}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wiz-cidades">{t("Cidades (uma por linha, Cidade/UF)")}</Label>
              <textarea
                id="wiz-cidades"
                className="min-h-20 w-full rounded-lg border bg-background px-3 py-2 text-sm"
                value={cidadesTexto}
                onChange={(e) => setCidadesTexto(e.target.value)}
                placeholder={t("Exemplo de cidades") + ": Canoinhas/SC, Mafra/SC"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wiz-rec">{t("Repetir a cada (dias, opcional)")}</Label>
              <Input
                id="wiz-rec"
                type="number"
                min={7}
                max={365}
                value={recorrencia}
                onChange={(e) => setRecorrencia(e.target.value)}
                placeholder="90"
              />
              <p className="text-xs text-muted-foreground">
                {t("Só registra a intenção — o agendador automático é fase futura.")}
              </p>
            </div>
          </div>
        </div>
      )}

      {passo === 1 && (
        <div className="space-y-3">
          {cidades.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Volte e informe ao menos 1 cidade.")}
            </p>
          ) : estimando || dadosEstimativa === null ? (
            <Skeleton className="h-32 w-full" />
          ) : dadosEstimativa.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Não foi possível estimar agora — dá para seguir mesmo assim.")}
            </p>
          ) : (
            <>
              <ul className="divide-y rounded-lg border">
                {dadosEstimativa.map((e) => (
                  <li
                    key={e.rotulo}
                    className="flex items-center justify-between gap-2 p-3 text-sm"
                  >
                    <span className="font-medium">{e.rotulo}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {e.empresas} {t("empresas")} · {e.clientes} {t("clientes")} ·{" "}
                      <strong className="text-text">
                        {e.potencial} {t("potenciais")}
                      </strong>
                    </span>
                  </li>
                ))}
              </ul>
              <NexusAiBriefing
                title={t("Leitura do potencial")}
                insights={insights}
                emptyText={t("Sem destaque de potencial nestas cidades.")}
              />
            </>
          )}
        </div>
      )}

      {passo === 2 && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="wiz-template">{t("Modelo de abordagem (opcional)")}</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id="wiz-template" className="w-full">
                <SelectValue placeholder={t("Escrever na mão")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__nenhum">{t("Escrever na mão")}</SelectItem>
                {(templates.data ?? []).map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wiz-msg">{t("Mensagem de abordagem")}</Label>
            <textarea
              id="wiz-msg"
              className="min-h-24 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              value={mensagemLivre || template?.body || ""}
              onChange={(e) => {
                setMensagemLivre(e.target.value);
                if (templateId !== "__nenhum") setTemplateId("__nenhum");
              }}
              placeholder={t("Olá {{primeiro_nome}}! Aqui é da …")}
            />
          </div>
          {preview ? (
            <div className="rounded-lg border border-border bg-surface-elevated p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
                {t("Pré-visualização")}
              </p>
              <p className="text-sm">{preview}</p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("Abordagem manual por empresa — nunca disparo automático sem consentimento.")}
          </p>
        </div>
      )}

      {passo === 3 && (
        <div className="space-y-3 text-sm">
          <dl className="space-y-1 rounded-lg border p-3">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("Campanha")}</dt>
              <dd className="font-medium">{nome.trim() || "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("Público")}</dt>
              <dd className="text-right tabular-nums">
                {marcadas.length} {t("categoria(s)")} · {cidades.length} {t("cidade(s)")}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("Mensagem")}</dt>
              <dd className="text-right">{mensagemFinal ? t("preparada") : t("sem mensagem")}</dd>
            </div>
          </dl>
          <label className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border p-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={aprovado}
              onChange={(e) => setAprovado(e.target.checked)}
            />
            <span>
              {t("Aprovo a execução desta campanha de descoberta.")}
              <span className="block text-xs text-muted-foreground">
                {t("Cria uma busca por cidade. Sem envio automático de mensagens.")}
              </span>
            </span>
          </label>
          <Button disabled={ocupado || !aprovado} onClick={criarEExecutar}>
            {ocupado ? t("Executando…") : t("Aprovar e executar")}
          </Button>
        </div>
      )}

      {passo === 4 && (
        <div className="space-y-3 text-sm">
          {resultado ? (
            <>
              <p className="text-base font-medium">{`${resultado.buscas} ${t("buscas criadas")}`}</p>
              {resultado.sem_mapa.length > 0 && (
                <p className="text-muted-foreground">
                  {t("Sem mapa")}: {resultado.sem_mapa.join(", ")}
                </p>
              )}
              <p className="text-muted-foreground">
                {t("Acompanhe o progresso na aba Pesquisas.")}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">{t("Nenhuma execução ainda.")}</p>
          )}
          <Button variant="outline" onClick={recomeçar}>
            {t("Nova campanha")}
          </Button>
        </div>
      )}

      {passo < 4 && (
        <div className="flex items-center justify-between gap-3">
          {passo > 0 ? (
            <Button variant="outline" onClick={() => setPasso((p) => Math.max(0, p - 1))}>
              {t("Voltar")}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={continuar}>{t("Continuar")}</Button>
        </div>
      )}
    </Card>
  );
}
