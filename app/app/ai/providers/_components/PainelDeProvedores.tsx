"use client";

/**
 * O painel de provedores de IA.
 *
 * ## A decisão de desenho que manda em tudo aqui
 *
 * São 23 pontos configuráveis. Mostrar 23 seletores de uma vez transformaria a
 * tela num painel de avião para alguém que não é engenheiro — e o resultado
 * previsível seria ninguém tocar em nada, o que devolve o problema original.
 *
 * Então a tela abre agrupada por PAPEL ("Atender o cliente", "Entender a
 * conversa"…), mostrando o que cada grupo usa hoje. Quem quiser precisão
 * abre "Configuração avançada" e escolhe ponto a ponto. O agrupamento é só de
 * exibição: o que se grava é sempre por ponto, porque o roteiro do produto
 * prevê modelo local, e modelo local pequeno só é confiável como especialista
 * de uma tarefa só.
 *
 * ## Por que cada cartão mostra "o que acontece se falhar"
 *
 * A pergunta que trouxe esta tela à existência não foi "qual modelo está aqui",
 * foi "por que isso falhou e eu não vi". Um painel que só lista provedor e
 * modelo responde a primeira e deixa a segunda de pé. Por isso cada ponto
 * carrega o sintoma em português de gente — é o que liga uma linha de
 * configuração a algo que a pessoa já viu acontecer no negócio dela.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { useT } from "@/hooks/i18n/useT";

interface Ponto {
  id: string;
  rotulo: string;
  oQueFaz: string;
  papel: string;
  exige: { tools?: boolean; imagem?: boolean; audio?: boolean; embeddingDims?: number };
  sintomaDeFalha: string;
  fixo: { razao: string } | null;
  mandadoPeloAgente: boolean;
  efetivo: {
    provider: string;
    modelId: string | null;
    credentialId: string | null;
    baseUrl: string | null;
    origem: string;
    porQue: string;
  };
  avisos: string[];
}

interface Modelo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price_per_million_cents: number | null;
}

interface Credencial {
  id: string;
  provider: string;
  label: string;
  api_key_last4: string | null;
}

interface Provedor {
  id: string;
  rotulo: string;
  quandoUsar: string;
  ondePegarAChave: string;
  /** Aceita apontar para outro endpoint (é compatível com a API da OpenAI). */
  aceitaEndpointProprio: boolean;
}

interface Dados {
  papeis: Record<string, { rotulo: string; explicacao: string }>;
  pontos: Ponto[];
  provedores: Provedor[];
  credenciais: Credencial[];
  modelos: Modelo[];
  podeEditar: boolean;
}

export function PainelDeProvedores() {
  const t = useT();
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [avancado, setAvancado] = useState<Record<string, boolean>>({});

  const carregar = useCallback(async () => {
    // O try/catch não é zelo genérico: sem ele, qualquer exceção (rede caindo,
    // resposta que não é JSON, erro 500 com corpo HTML) deixava a tela presa em
    // "Carregando…" PARA SEMPRE, sem nada explicando. Medido na primeira
    // execução do e2e desta tela — que é a mesma falha muda que este painel
    // veio acabar, recriada dentro dele.
    try {
      const res = await fetch("/api/v1/ai/providers");
      const texto = await res.text();
      type Resposta = { data?: unknown; error?: { message?: string } };
      let json: Resposta | null = null;
      try {
        json = JSON.parse(texto) as Resposta;
      } catch {
        // Corpo não-JSON quer dizer que a resposta nem chegou ao handler
        // (proxy, erro de runtime). O começo do corpo é o que há de mais
        // informativo, então ele vai para a tela em vez de sumir no console.
        setErro(`${t("resposta inesperada do servidor")} (${res.status}): ${texto.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setErro(
          json?.error?.message
            ? t(json.error.message)
            : `${t("não consegui carregar a configuração")} (${res.status})`,
        );
        return;
      }
      setErro(null);
      setDados(json?.data as Dados);
    } catch (e) {
      setErro(e instanceof Error ? t(e.message) : t("não consegui falar com o servidor"));
    }
  }, [t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const porPapel = useMemo(() => {
    if (!dados) return [];
    const grupos = new Map<string, Ponto[]>();
    for (const p of dados.pontos) {
      grupos.set(p.papel, [...(grupos.get(p.papel) ?? []), p]);
    }
    return [...grupos.entries()].map(([papel, pontos]) => ({
      papel,
      info: dados.papeis[papel] ?? { rotulo: papel, explicacao: "" },
      pontos,
    }));
  }, [dados]);

  if (erro) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40 p-6">
          <h2 className="font-medium">{t("Não consegui carregar a configuração de IA")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{erro}</p>
          <Button className="mt-4" variant="outline" onClick={() => void carregar()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      </div>
    );
  }

  if (!dados) {
    return <div className="p-6 text-sm text-muted-foreground">{t("Carregando…")}</div>;
  }

  const semChave = dados.credenciais.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="painel-de-provedores">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Provedores de IA")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("Seu sistema usa inteligência artificial em")} {dados.pontos.length}{" "}
          {t("lugares diferentes. Aqui você vê qual está atendendo cada um — e troca, se quiser.")}
        </p>
      </header>

      {semChave && (
        <Card className="mb-6 border-amber-500/40 bg-amber-500/5 p-4" data-testid="aviso-sem-chave">
          <p className="text-sm">
            {t(
              "Você ainda não cadastrou nenhuma chave de provedor. Enquanto isso, tudo usa a chave que veio na instalação.",
            )}{" "}
            <Link className="underline underline-offset-4" href="/app/ai/credentials">
              {t("Cadastrar uma chave")}
            </Link>
          </p>
        </Card>
      )}

      <div className="space-y-8">
        {porPapel.map(({ papel, info, pontos }) => (
          <section key={papel} data-testid={`papel-${papel}`}>
            <div className="mb-3">
              <h2 className="text-lg font-medium">{t(info.rotulo)}</h2>
              <p className="text-sm text-muted-foreground">{t(info.explicacao)}</p>
            </div>

            <ResumoDoGrupo pontos={pontos} />

            <div className="mt-3">
              <Button
                variant="ghost"
                size="sm"
                data-testid={`avancado-${papel}`}
                onClick={() => setAvancado((a) => ({ ...a, [papel]: !a[papel] }))}
              >
                {avancado[papel] ? t("Ocultar") : t("Configuração avançada")} ({pontos.length}{" "}
                {pontos.length === 1 ? t("ponto") : t("pontos")})
              </Button>
            </div>

            {avancado[papel] && (
              <div className="mt-3 space-y-3">
                {pontos.map((ponto) => (
                  <CartaoDoPonto
                    key={ponto.id}
                    ponto={ponto}
                    dados={dados}
                    aoSalvar={carregar}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** O que o grupo usa hoje, sem obrigar a abrir ponto a ponto. */
function ResumoDoGrupo({ pontos }: { pontos: Ponto[] }) {
  const t = useT();
  const modelos = [...new Set(pontos.map((p) => p.efetivo.modelId ?? t("não definido")))];
  const comAviso = pontos.filter((p) => p.avisos.length > 0).length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("Usando:")}</span>
        {modelos.map((m) => (
          <Badge key={m} variant="secondary" className="font-mono text-xs">
            {m}
          </Badge>
        ))}
      </div>
      {comAviso > 0 && (
        <p className="mt-2 text-sm text-amber-600 dark:text-amber-500" data-testid="grupo-com-aviso">
          {comAviso === 1
            ? t("1 ponto deste grupo precisa da sua atenção.")
            : `${comAviso} ${t("pontos deste grupo precisam da sua atenção.")}`}
        </p>
      )}
    </Card>
  );
}

function CartaoDoPonto({
  ponto,
  dados,
  aoSalvar,
}: {
  ponto: Ponto;
  dados: Dados;
  aoSalvar: () => Promise<void>;
}) {
  const t = useT();
  const [provider, setProvider] = useState(ponto.efetivo.provider);
  const [modelId, setModelId] = useState(ponto.efetivo.modelId ?? "");
  const [credentialId, setCredentialId] = useState(ponto.efetivo.credentialId ?? "");
  const [baseUrl, setBaseUrl] = useState(ponto.efetivo.baseUrl ?? "");
  const [salvando, setSalvando] = useState(false);

  const modelosDoProvider = dados.modelos.filter((m) => m.provider === provider);
  const credsDoProvider = dados.credenciais.filter((c) => c.provider === provider);
  // Endpoint próprio só faz sentido em provedor compatível com a API da OpenAI
  // — é a mesma condição que `lib/ai/pontos/provedores.ts` declara e que o
  // registry aplica junto da allowlist do egress.
  const aceitaEndpointProprio =
    dados.provedores.find((p) => p.id === provider)?.aceitaEndpointProprio === true;

  const editavel = dados.podeEditar && ponto.fixo === null && !ponto.mandadoPeloAgente;

  async function salvar() {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/ai/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: ponto.id,
          provider,
          model_id: modelId,
          credential_id: credentialId || null,
          // A coluna existia, o PUT a aceitava e o registry a honrava — e nada
          // na tela a enviava. Quem quisesse apontar para um gateway próprio (o
          // caso declarado como motivação da coluna, e o degrau para modelo
          // local) só conseguia pela API. Configuração sem superfície é
          // capacidade que ninguém alcança.
          base_url: aceitaEndpointProprio && baseUrl.trim() !== "" ? baseUrl.trim() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // A mensagem do servidor é escrita para leigo (ver validar-binding.ts).
        // `t()` repassa direto quando não há entrada no dicionário — não é
        // traduzir de novo, é a mesma degradação graciosa do resto do app.
        toast.error(json?.error?.message ? t(json.error.message) : t("não consegui salvar"));
        return;
      }
      const avisos: string[] = json?.data?.avisos ?? [];
      if (avisos.length > 0) avisos.forEach((a) => toast.warning(t(a)));
      else toast.success(`"${t(ponto.rotulo)}" ${t("agora usa")} ${modelId}`);
      await aoSalvar();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="p-4" data-testid={`ponto-${ponto.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{t(ponto.rotulo)}</h3>
            {ponto.exige.tools && (
              <Badge variant="outline" className="text-xs">
                {t("precisa de ferramentas")}
              </Badge>
            )}
            {ponto.fixo && (
              <Badge variant="secondary" className="text-xs">
                {t("fixo")}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t(ponto.oQueFaz)}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div className="font-mono">{ponto.efetivo.modelId ?? "—"}</div>
          <div data-testid={`origem-${ponto.id}`}>{t(ponto.efetivo.porQue)}</div>
        </div>
      </div>

      {/* O que a pessoa VÊ quando este ponto falha. É a razão de a tela existir. */}
      <p className="mt-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
        <span className="font-medium">{t("Se falhar:")}</span> {t(ponto.sintomaDeFalha)}
      </p>

      {ponto.avisos.map((a) => (
        <p
          key={a}
          className="mt-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-500"
          data-testid={`aviso-${ponto.id}`}
        >
          {t(a)}
        </p>
      ))}

      {ponto.fixo && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`razao-fixo-${ponto.id}`}>
          {t(ponto.fixo.razao)}
        </p>
      )}

      {ponto.mandadoPeloAgente && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("Este ponto usa o modelo definido na versão publicada do agente.")}{" "}
          <Link className="underline underline-offset-4" href="/app/ai/agents">
            {t("Configurar no agente")}
          </Link>
        </p>
      )}

      {editavel && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs">{t("Provedor")}</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                setModelId("");
                setCredentialId("");
              }}
            >
              <SelectTrigger data-testid={`provider-${ponto.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dados.provedores.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.rotulo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">{t("Modelo")}</Label>
            {/*
              Catálogo vazio não pode ser beco sem saída. O `baseline.sql` semeia
              `ai_models` só para anthropic/openai/google; os da OpenRouter só
              chegam quando o cron diário roda. Numa VPS recém-instalada, quem
              escolhia OpenRouter via um combo com zero opções e o Salvar
              desabilitado — travado até as 04h15 do dia seguinte, e para sempre
              num deploy sem scheduler. Aqui o campo vira texto livre: a API já
              aceita modelo fora do catálogo e devolve o aviso de que não
              conhece (`validar-binding.ts`, `conhecido: false`).
            */}
            {modelosDoProvider.length === 0 ? (
              <>
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="ex.: meta-llama/llama-3.3-70b-instruct"
                  data-testid={`modelo-${ponto.id}`}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    "O catálogo deste provedor ainda não foi baixado. Digite o identificador do modelo como o provedor o nomeia — a lista completa aparece sozinha depois da primeira sincronização.",
                  )}
                </p>
              </>
            ) : (
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger data-testid={`modelo-${ponto.id}`}>
                  <SelectValue placeholder={t("escolha")} />
                </SelectTrigger>
                <SelectContent>
                  {modelosDoProvider.map((m) => (
                    <SelectItem key={m.model_id} value={m.model_id}>
                      {m.display_name}
                      {ponto.exige.tools && !m.supports_tools ? ` — ${t("sem ferramentas")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <Label className="text-xs">{t("Chave")}</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger data-testid={`chave-${ponto.id}`}>
                <SelectValue placeholder={t("da instalação")} />
              </SelectTrigger>
              <SelectContent>
                {credsDoProvider.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label} ••{c.api_key_last4 ?? "??"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {aceitaEndpointProprio && (
            <div className="sm:col-span-3">
              <Label className="text-xs">{t("Endereço próprio (opcional)")}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://mi-gateway.ejemplo.com/v1"
                data-testid={`base-url-${ponto.id}`}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "Deixe em branco para usar o endereço oficial do provedor. Use isto para apontar para um gateway compatível com a API da OpenAI — inclusive um modelo rodando na sua própria máquina.",
                )}
              </p>
            </div>
          )}

          <div className="sm:col-span-3">
            <Button
              size="sm"
              disabled={salvando || !modelId}
              onClick={() => void salvar()}
              data-testid={`salvar-${ponto.id}`}
            >
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
