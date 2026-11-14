"use client";
/**
 * TestPanel — dry-run de uma version (S-13.12).
 *
 * O teste é uma CONVERSA (#4424): cada envio leva a mensagem nova + os turnos
 * anteriores no corpo do POST `:test` (admin-only), e o painel mostra turno a
 * turno o que a IA respondeu e quais ferramentas usou. O rascunho da conversa
 * vive só no estado desta tela — sem tabela nova; recarregar recomeça.
 *
 * Não toca o canal, não cria messages.outbound e não altera cliente algum.
 * Quando `INTERNAL_AGENT_RUN_STUB=true` o backend devolve trace stub com
 * `stub: true`; o componente mostra um aviso amigável.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { agentRunsKey } from "@/hooks/ai/useAgentRuns";
import { useT } from "@/hooks/i18n/useT";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

import type { SelectableChannel as ChannelSessionLite } from "@/lib/channels/selectable";
import {
  canalEmModoDeTeste,
  decidirAvisoDoModoDeTeste,
} from "@/lib/ai/elegibilidade/aviso-do-modo-de-teste";
import { useAcessoDaAiDoCanal } from "@/hooks/channels/useAcessoDaAiDoCanal";

import { AvisoDoModoDeTeste } from "./AvisoDoModoDeTeste";
import { RunTrace } from "./RunTrace";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  readOnly?: boolean;
  /**
   * Os canais da organização, para o modo de teste do canal DESTA versão.
   *
   * Vem por prop do mesmo jeito que no editor: o resumo (`acessoDaAi`) já chega
   * pronto de `listSelectableChannels`, e a lista de telefones só é buscada por
   * quem pode ver (administrador). Sem isso, o teste da aba dava resposta verde
   * para um número que o WhatsApp real nunca atenderia (#3976).
   */
  channelSessions?: ChannelSessionLite[];
}

interface TestResponse {
  data: {
    run_id: string;
    status: string;
    final_text?: string | null;
    tool_calls?: unknown;
    tokens_in?: number;
    tokens_out?: number;
    cost_cents?: number;
    latency_ms?: number;
    would_send_to?: { session?: string | null; chat_id?: string | null };
    stub?: boolean;
    candidates?: Array<{ body: string; trace: Array<{ gate: string; verdict: string }> }>;
    proposals?: Array<{ tool: string; arguments: unknown }>;
    impediments?: Array<{ code: string; message: string }>;
    /**
     * Não bloqueiam o teste: dizem o que impediria o ENVIO real agora (ex.: fora
     * do horário). Ver `gatesDoSandbox` em lib/agent-engine/agent/preview.ts.
     */
    warnings?: Array<{ code: string; message: string }>;
    restrictions?: string[];
    /**
     * #4424 — as ferramentas que o turno REALMENTE chamou (as de leitura rodam de
     * verdade na prévia). Vem do mesmo coletor que grava o traço do turno; antes
     * o painel só enxergava as ações PROPOSTAS.
     */
    ferramentas?: Array<{
      nome: string;
      estado: "ok" | "falhou" | "bloqueada";
      erro?: string | null;
      codigo?: string;
      duracao_ms?: number;
    }>;
    /** Ver lib/ai/agents/avaliar-resposta-de-teste.ts. */
    guardrails?: {
      passou: boolean;
      /** false = não havia texto para avaliar (teste sem resposta). */
      avaliado?: boolean;
      categorias: string[];
      termos: string[];
      naoAvaliados: Array<{ gate: string; porque: string }>;
    };
  };
}

/** Um turno do teste: o que o admin digitou e o que a IA respondeu, com o que usou. */
interface TurnoDoTeste {
  pergunta: string;
  resultado: TestResponse["data"];
}

/**
 * Os limites que o painel e a rota compartilham (#4424). O histórico do teste
 * vive só no estado desta tela: ele é recortado AQUI para caber no teto e viaja
 * no corpo do POST. Se a tela mandasse a conversa inteira, a rota recusaria com
 * 400 — e, pior, cada disparo custaria mais tokens sem necessidade.
 */
const LIMITE_DE_MENSAGENS_DO_HISTORICO = 30;
const LIMITE_DE_CARACTERES_DO_HISTORICO = 20_000;
const LIMITE_DE_CARACTERES_POR_MENSAGEM = 4000;

/**
 * A conversa do teste no formato que a rota aceita: cada turno vira a mensagem
 * do cliente e a resposta da IA (quando houve). O recorte é do FIM para o
 * começo — o passado mais recente é o que importa —, respeitando 30 mensagens e
 * 20.000 caracteres no total.
 *
 * Exportada para o teste poder exercitar o recorte sem montar a tela inteira.
 */
export function historicoDaConversa(
  turnos: TurnoDoTeste[],
): Array<{ direction: "inbound" | "outbound"; body: string }> {
  const todas: Array<{ direction: "inbound" | "outbound"; body: string }> = [];
  for (const turno of turnos) {
    todas.push({
      direction: "inbound",
      // O teto por mensagem é o mesmo de `sample_message`; uma resposta muito
      // longa é truncada em vez de fazer o próximo disparo ser recusado.
      body: turno.pergunta.slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM),
    });
    const resposta = turno.resultado.final_text?.trim();
    if (resposta) {
      todas.push({
        direction: "outbound",
        body: resposta.slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM),
      });
    }
  }
  const recortadas: Array<{ direction: "inbound" | "outbound"; body: string }> = [];
  let caracteres = 0;
  for (let i = todas.length - 1; i >= 0; i -= 1) {
    const mensagem = todas[i];
    if (!mensagem) continue;
    if (recortadas.length >= LIMITE_DE_MENSAGENS_DO_HISTORICO) break;
    if (caracteres + mensagem.body.length > LIMITE_DE_CARACTERES_DO_HISTORICO) break;
    recortadas.unshift(mensagem);
    caracteres += mensagem.body.length;
  }
  return recortadas;
}

/**
 * O que as verificações disseram sobre a resposta — e o que elas NÃO puderam
 * dizer.
 *
 * Este componente mostra o resultado da checagem textual suplementar. O motor
 * de prévia executa verificações próprias com contexto simulado; nenhuma delas
 * é prova de que o envio real esteja liberado.
 */
function Verificacoes({ g }: { g: NonNullable<TestResponse["data"]["guardrails"]> }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="teste-verificacoes">
      {/* Sem texto não há veredito: nem "limpo", nem "vazou". */}
      {g.avaliado === false ? null : g.passou ? (
        <p
          data-testid="teste-vazamento-limpo"
          className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs"
        >
          {t("A resposta não usa palavras internas do sistema.")}
        </p>
      ) : (
        <div
          data-testid="teste-vazamento-achado"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
        >
          <p className="font-medium text-destructive">
            {t("Esta resposta usa palavras que o cliente não deveria ver.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Em produção ela seria barrada e o assistente teria que reescrever. Encontrado:")}{" "}
            <span className="font-mono">{g.termos.join(", ")}</span>
          </p>
        </div>
      )}

      {/* Esta lista descreve somente o alcance da checagem textual adicional. */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer" data-testid="teste-nao-verificado">
          {t("A checagem textual não reavalia todas as regras (")}
          {g.naoAvaliados.length} {t("verificações fora desta camada)")}
        </summary>
        <ul className="mt-2 space-y-1 pl-4">
          {g.naoAvaliados.map((n) => (
            <li key={n.gate}>— {n.porque}</li>
          ))}
        </ul>
        <p className="mt-2">
          {t(
            "O motor de prévia pode executar algumas dessas verificações com dados simulados e fazer chamadas ao modelo. Isso não comprova liberação para envio real. Para ver as regras de envio, abra a aba",
          )}{" "}
          <span className="font-medium text-foreground">{t("Confere antes de enviar")}</span>.
        </p>
      </details>
    </div>
  );
}

export function TestPanel({ agent, draft, published, readOnly, channelSessions }: Props) {
  const t = useT();
  const telefoneExemplo = useTelefoneExemplo();
  const target = draft ?? published;
  const qc = useQueryClient();

  const [message, setMessage] = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [contactPhone, setContactPhone] = React.useState("");
  // Etiquetas SIMULADAS da conversa (spec 27): texto separado por vírgula; o servidor normaliza.
  const [contactTags, setContactTags] = React.useState("");
  const [pending, setPending] = React.useState(false);
  /**
   * A CONVERSA do teste (#4424). Cada disparo acrescenta um turno; o anterior
   * continua na tela e os dois (cliente e IA) voltam no corpo do próximo POST.
   * Nada disso é persistido: recarregar a página recomeça a conversa, e não há
   * tabela nova — o estado da tela é o único dono do rascunho.
   */
  const [turnos, setTurnos] = React.useState<TurnoDoTeste[]>([]);
  const result = turnos.length > 0 ? turnos[turnos.length - 1]!.resultado : null;

  /**
   * O número desta versão está em modo de teste? O teste da aba NÃO passa pelo
   * canal (é dry-run), então ele respondia normalmente para um número que o
   * WhatsApp real descartaria — "testei aqui e funcionou, no celular não".
   *
   * O resumo vem com a página; a LISTA de telefones só é buscada por quem pode
   * editá-la (administrador). `readOnly` falso e canal em modo de teste com
   * lista é a única combinação que pede a lista.
   */
  const canalDaVersao =
    channelSessions?.find((c) => c.id === target?.channel_session_id) ?? null;
  const acessoDoCanal = canalDaVersao?.acessoDaAi ?? null;
  const lerNumeros =
    !readOnly && canalEmModoDeTeste(acessoDoCanal) && (acessoDoCanal?.testNumbersCount ?? 0) > 0;
  const listaAutorizada = useAcessoDaAiDoCanal(canalDaVersao?.id, lerNumeros);
  const avisoDoNumero = decidirAvisoDoModoDeTeste({
    acesso: acessoDoCanal,
    numerosDeTeste: listaAutorizada.acesso?.test_phone_numbers ?? null,
    numeroEmTeste: contactPhone,
  });

  if (!target) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Configure e salve uma versão antes de testar.")}
      </p>
    );
  }

  const versionLabel =
    target.status === "published"
      ? `v${target.version_number} ${t("(publicada)")}`
      : `v${target.version_number} ${t("(rascunho)")}`;

  async function handleRun() {
    if (!message.trim()) {
      toast.error(t("Informe uma mensagem de teste."));
      return;
    }
    if (!target) return;
    const pergunta = message.trim();
    setPending(true);
    try {
      const body: Record<string, unknown> = { sample_message: pergunta };
      // #4424 — o turno novo viaja com os anteriores. Sem isso, a IA avaliava
      // cada mensagem sozinha: não dava para ver objeção, mudança de assunto
      // nem volta ao preço. O recorte respeita o teto que a rota impõe.
      const history = historicoDaConversa(turnos);
      if (history.length > 0) body.history = history;
      if (contactName.trim() || contactPhone.trim()) {
        body.sample_contact = {
          ...(contactName.trim() ? { name: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { phone: contactPhone.trim() } : {}),
        };
      }
      const etiquetasSimuladas = contactTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
      if (etiquetasSimuladas.length) body.sample_tags = etiquetasSimuladas;
      const res = await apiClient.post<TestResponse>(
        `/api/v1/ai/agents/${agent.id}/versions/${target.id}/test`,
        body,
        // ⚠️ O padrão do cliente é 10s, e um turno de agente NÃO cabe nele: o
        // teste roda o motor inteiro (classificador de etapa, jailbreak, o
        // agente com as ferramentas, checkpoint, verificação de promessa).
        // Medido numa instalação real: 14,5s só na chamada ao modelo. Com 10s,
        // o resultado nunca chegava — o painel ficava em "Nenhum teste
        // executado ainda" enquanto o servidor terminava e devolvia para
        // ninguém (issue #783).
        //
        // 120s é o teto do orçamento de passos do agente, não um chute
        // confortável: acima disso o problema é o agente, não a espera.
        { timeoutMs: 120_000 },
      );
      setTurnos((anteriores) => [...anteriores, { pergunta, resultado: res.data }]);
      setMessage("");
      qc.invalidateQueries({ queryKey: agentRunsKey(agent.id) });
      toast.success(t("Teste executado."));
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(t(err.message) || `${t("Erro")}: ${err.code}`);
      } else {
        toast.error(t("Erro inesperado."));
      }
    } finally {
      setPending(false);
    }
  }

  /** Recomeçar: limpa o rascunho da conversa e o painel. O próximo turno chega sozinho ao motor. */
  function handleRestart() {
    setTurnos([]);
    setMessage("");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Versão alvo")}
          </p>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline">{versionLabel}</Badge>
            <span className="font-mono text-xs">
              {target.provider} / {target.model}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {t("⚠ Modo teste consome créditos do provider.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Nenhuma mensagem é enviada via WhatsApp. O run é registrado como dry-run.")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-message">{t("Mensagem do cliente (sample)")}</Label>
          <Textarea
            id="test-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("Oi, quanto custa X?")}
            rows={4}
            disabled={pending || readOnly}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="test-name">{t("Nome (opcional)")}</Label>
            <Input
              id="test-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Maria"
              disabled={pending || readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="test-phone">{t("Telefone (opcional)")}</Label>
            <Input
              id="test-phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder={telefoneExemplo}
              disabled={pending || readOnly}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-tags">{t("Etiquetas da conversa (simulação)")}</Label>
          <Input
            id="test-tags"
            value={contactTags}
            onChange={(e) => setContactTags(e.target.value)}
            placeholder={t("Ex.: estetica, vip")}
            disabled={pending || readOnly}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Separe por vírgula. As skills com estas etiquetas entram neste teste, como entrariam numa conversa com elas.",
            )}
          </p>
        </div>

        <AvisoDoModoDeTeste aviso={avisoDoNumero} podeConfigurar={!readOnly} notaDoSandbox />

        <div className="flex items-center gap-2">
          <Button onClick={handleRun} disabled={pending || readOnly}>
            {pending ? t("Executando…") : turnos.length > 0 ? t("Enviar mensagem") : t("Executar teste")}
          </Button>
          {turnos.length > 0 ? (
            <Button variant="outline" onClick={handleRestart} disabled={pending || readOnly}>
              {t("Recomeçar conversa")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Conversa")}
          </p>
          {turnos.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {turnos.length} {turnos.length === 1 ? t("turno") : t("turnos")}
            </p>
          ) : null}
        </div>

        {!result && !pending ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum teste executado ainda.")}</p>
        ) : null}

        {pending ? (
          <p className="text-sm text-muted-foreground">{t("Executando dry-run…")}</p>
        ) : null}

        {turnos.map((turno, indice) => (
          <TurnoDoTesteCard key={indice} turno={turno} indice={indice + 1} />
        ))}

        {result ? (
          <>
            {result.stub ? (
              <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
                {t(
                  "Provedor de teste controlado. O motor e as verificações são os mesmos; não há chamada a uma IA externa.",
                )}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label={t("Status")}>{result.status}</Cell>
              <Cell label={t("Latência")}>
                {typeof result.latency_ms === "number" ? `${result.latency_ms}ms` : "—"}
              </Cell>
              <Cell label={t("Tokens in/out")}>
                {result.tokens_in?.toLocaleString()??"—"} /{" "}
                {result.tokens_out?.toLocaleString()??"—"}
              </Cell>
              <Cell label={t("Custo (cents)")}>{result.cost_cents ?? "—"}</Cell>
            </div>

            {result.candidates ? (
              <div className="space-y-2 text-xs">
                <p>
                  {t(
                    "Mesmo motor e conhecimento do agente; nenhuma alteração é aplicada ao cliente.",
                  )}
                </p>
                <p>
                  {t(
                    "Estado do contato simulado. Canal, opt-out e contexto serão conferidos novamente antes de um envio real.",
                  )}
                </p>
                {result.candidates.map((candidate, i) => (
                  <details key={i}>
                    <summary>{t("Verificações da resposta")}</summary>
                    <pre className="overflow-auto whitespace-pre-wrap">
                      {JSON.stringify(candidate.trace, null, 2)}
                    </pre>
                  </details>
                ))}
                {result.warnings?.map((x, i) => (
                  <p
                    role="status"
                    key={`aviso-${i}`}
                    data-testid="teste-aviso-de-envio"
                    className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2"
                  >
                    {x.message}
                  </p>
                ))}
                {/* #4592 — os vetos saem no card do TURNO que os levou
                    (`TurnoDoTesteCard`), com o código da trava; repetir aqui a
                    mesma frase do último turno só duplicava o aviso na tela. */}
              </div>
            ) : result.guardrails ? (
              <Verificacoes g={result.guardrails} />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Um turno da conversa de teste (#4424).
 *
 * Mostra o que o admin digitou, o que a IA respondeu e — o ponto do pedido — o
 * que ela USOU para responder: as ferramentas chamadas (as de leitura rodam de
 * verdade na prévia) e as ações que ficaram só propostas. Nada aqui é enviado a
 * cliente algum; o turno inteiro roda em modo dry-run.
 */
function TurnoDoTesteCard({ turno, indice }: { turno: TurnoDoTeste; indice: number }) {
  const t = useT();
  const { resultado } = turno;
  const resposta = resultado.final_text?.trim() ?? "";
  const ferramentas = resultado.ferramentas ?? [];
  const propostas = resultado.proposals ?? [];
  /**
   * Os vetos das travas neste turno (#4592). É o único lugar em que o texto
   * barrado aparece com o CÓDIGO da trava: antes só existia em `impediments` na
   * resposta da API, e quem testava não distinguia "o agente errou a frase" de
   * "a trava cortou a frase certa".
   */
  const impedimentos = resultado.impediments ?? [];
  return (
    <div
      data-testid={`teste-turno-${indice}`}
      className="space-y-2 rounded-md border border-border/60 bg-background p-3"
    >
      <div>
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("Cliente")} · {t("turno")} {indice}
        </p>
        <p className="text-sm whitespace-pre-wrap">{turno.pergunta}</p>
      </div>
      <div>
        <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("Agente")} · {t("turno")} {indice}
        </p>
        <p className="text-sm whitespace-pre-wrap">
          {resposta || t("A IA não devolveu texto neste turno.")}
        </p>
      </div>
      {ferramentas.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("Ferramentas usadas")}
          </p>
          <ul className="flex flex-wrap gap-1">
            {ferramentas.map((f, i) => (
              <li key={`${f.nome}-${i}`}>
                <Badge
                  variant={f.estado === "ok" ? "outline" : "destructive"}
                  className="font-mono text-xs"
                >
                  {f.nome}
                  {typeof f.duracao_ms === "number" ? ` · ${f.duracao_ms}ms` : ""}
                  {f.estado === "ok" ? "" : ` · ${t("falhou")}`}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {propostas.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("Ações propostas (não executadas)")}
          </p>
          <ul className="flex flex-wrap gap-1">
            {propostas.map((p, i) => (
              <li key={`${p.tool}-${i}`}>
                <Badge variant="secondary" className="font-mono text-xs">
                  {p.tool}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {impedimentos.length > 0 ? (
        <div
          data-testid={`teste-vetos-${indice}`}
          className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
        >
          <p className="font-medium text-destructive">{t("Vetado pela trava antes de enviar")}</p>
          <p className="text-muted-foreground">
            {t(
              "O agente escreveu esta resposta, mas a verificação de envio a barrou: o texto não chegaria ao cliente. O código abaixo identifica a trava que cortou.",
            )}
          </p>
          <ul className="space-y-1">
            {impedimentos.map((x, i) => (
              <li key={`${x.code}-${i}`}>
                <span className="font-mono">{x.code}</span>
                <span className="text-muted-foreground"> — {x.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("Detalhes do turno")}</summary>
        <div className="mt-2 space-y-2">
          {ferramentas.some((f) => f.erro) ? (
            <ul className="space-y-1">
              {ferramentas.map((f, i) =>
                f.erro ? (
                  <li key={`erro-${i}`} className="font-mono text-destructive">
                    {f.nome}: {f.erro}
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}
          <RunTrace
            toolCalls={resultado.tool_calls}
            finalText={null}
            emptyMessage={t("Sem ações propostas neste turno.")}
          />
        </div>
      </details>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-mono">{children}</p>
    </div>
  );
}
