"use client";

/**
 * O cartão "servidor de ferramentas externo no atendimento" (#2147, opção A) —
 * e, desde a #3586, também a ESCOLHA por ferramenta (item 6 do mesmo desenho).
 *
 * ── O que este cartão fazia e o que faltava ────────────────────────────────
 *
 * Ele era só um interruptor: gravava `config.mcp_externo_no_atendimento` e
 * nunca tocava em `tool_ids`. O runtime monta ferramenta remota com DUAS
 * condições (`lib/ai/runtime/tools.ts`, bloco "Ferramentas remotas ESCOLHIDAS"):
 * a flag do servidor E alguma escolha `mcp_externo:*` no `tool_ids` da versão.
 * Com o interruptor ligado e nenhuma escolha, o agente não recebia ferramenta
 * nenhuma — e o servidor não via requisição nenhuma, nem `tools/list`. Quem
 * relatou a #3586 viu exatamente isso: "Testar conexão" com 4 requisições no log
 * do servidor, atendimento real com 0.
 *
 * ── De onde vem a lista ────────────────────────────────────────────────────
 *
 * Da action `listarFerramentasMcpExternas` — a MESMA chamada que o "Testar
 * conexão" da tela de cadastro faz. Não existe uma segunda forma de falar com o
 * servidor: quem lista é `carregarServidorMcpExterno`, com o guard anti-SSRF e a
 * chave cifrada que só o servidor conhece.
 *
 * ── A marca é do ADMINISTRADOR, nunca do servidor ──────────────────────────
 *
 * `annotations.readOnlyHint` é DECLARAÇÃO do sistema alheio, não garantia: um
 * ERP que se diga `readOnly` num `cancelar_pedido` passaria como leitura e
 * executaria durante uma conversa. Por isso a marca nasce **escrita** — falha
 * fechado — e só vira `leitura` quando o administrador escolhe, ferramenta por
 * ferramenta. A declaração do servidor serve para uma coisa só: decidir se a
 * opção `leitura` pode ser OFERECIDA. A decisão continua sendo de quem clica.
 *
 * ── Por que a escolha passa pelo `onChangeToolIds` e não é PATCH aqui ──────
 *
 * `tool_ids` é da VERSÃO, e o editor o salva pelo mesmo botão que salva o resto
 * do formulário (`saveAgentDraftAction`). Gravar a escolha por fora, num PATCH
 * direto, deixaria o formulário com a lista velha em memória: o "Salvar" logo
 * depois reescreveria a versão sem as remotas — o administrador veria a marca
 * desaparecer sem erro nenhum. Por isso o cartão entrega os ids para o
 * formulário, como o `ToolPicker` faz.
 *
 * O interruptor continua sendo PATCH imediato (é `config` do agente, não da
 * versão) — comportamento de antes, com a mesma rota admin-only.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  listarFerramentasMcpExternas,
  type OpcaoRemotaParaOEditor,
  type ResultadoDaListagem,
} from "@/app/actions/settings/listarFerramentasMcpExternas";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  desmarcarRemota,
  marcaDaRemota,
  marcarRemota,
  removerRemotasOrfas,
  remotasOrfas,
} from "@/lib/mcp/servidor-externo/escolha-do-editor";
import { escolhasRemotas, type MarcaRemota } from "@/lib/mcp/servidor-externo/ids";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";

interface Props {
  agentId: string;
  /** `ai_agents.config.mcp_externo_no_atendimento` como está no banco (pode ser undefined). */
  inicial: unknown;
  /** O `tool_ids` da versão em edição — onde a ESCOLHA mora (item 6). */
  toolIds: readonly string[];
  onChangeToolIds: (ids: string[]) => void;
  disabled?: boolean;
}

/** A frase de cada recusa da action, em português (a chave é o texto). */
const MENSAGEM_DA_RECUSA: Record<
  Extract<ResultadoDaListagem, { ok: false }>["error"],
  string
> = {
  unauthenticated: "Sua sessão expirou. Entre de novo para continuar.",
  forbidden_role: "Só o dono da instalação vê as ferramentas do servidor externo.",
  forbidden_tenant: "Não foi possível identificar a empresa ativa desta sessão.",
  mfa_required: "Esta ação exige a verificação em duas etapas.",
  upstream_unavailable: "Não foi possível falar com o servidor.",
  sem_servidor:
    "Nenhum servidor externo respondeu. Confira o endereço e a chave em Configurações › Servidor MCP externo.",
};

export function ServidorExternoNoAtendimento({
  agentId,
  inicial,
  toolIds,
  onChangeToolIds,
  disabled,
}: Props) {
  const t = useT();
  const [ligado, setLigado] = useState<boolean>(inicial === true);
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  /** O que o servidor anunciou — `null` antes da primeira listagem bem-sucedida. */
  const [ferramentas, setFerramentas] = useState<readonly OpcaoRemotaParaOEditor[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  /** Recusa do teto — o `tool_ids` inteiro conta para o limite do zod. */
  const [recusa, setRecusa] = useState<string | null>(null);

  const escolhidas = escolhasRemotas(toolIds);
  const anunciadas = ferramentas?.map((f) => f.nome) ?? [];
  // Órfã só se sabe com a listagem na mão: servidor fora do ar não transforma
  // escolha salva em órfã, e é isso que impede o erro de apagar o que existe.
  const orfas = ferramentas === null ? [] : remotasOrfas(toolIds, anunciadas);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await listarFerramentasMcpExternas();
      if (!r.ok) {
        // Nem `setFerramentas([])` nem `onChangeToolIds`: a lista não veio, e o
        // que está salvo continua valendo.
        setFerramentas(null);
        setErro(t(MENSAGEM_DA_RECUSA[r.error]));
        return;
      }
      setFerramentas(r.ferramentas);
    } catch {
      setFerramentas(null);
      setErro(t("Não foi possível falar com o servidor."));
    } finally {
      setCarregando(false);
    }
  }, [t]);

  // Lista quando o interruptor está ligado. Desligado não abre rede: o cartão
  // de um agente sem a opção ligada é o de antes da #3586.
  useEffect(() => {
    if (ligado && ferramentas === null && !carregando && erro === null) void carregar();
  }, [ligado, ferramentas, carregando, erro, carregar]);

  async function alternar(valor: boolean) {
    const anterior = ligado;
    setLigado(valor);
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { mcp_externo_no_atendimento: valor },
      });
      toast.success(
        valor
          ? t("Servidor de ferramentas externo ligado no atendimento.")
          : t("Servidor de ferramentas externo desligado no atendimento."),
      );
    } catch (err) {
      setLigado(anterior);
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  function alternarFerramenta(opcao: OpcaoRemotaParaOEditor, marcada: boolean) {
    setRecusa(null);
    if (!marcada) {
      onChangeToolIds(desmarcarRemota(toolIds, opcao.nome));
      return;
    }
    if (toolIds.length >= TETO_TOOLS_POR_AGENTE) {
      setRecusa(
        `${t("Você já ligou")} ${TETO_TOOLS_POR_AGENTE} ${t(
          "capacidades. Desligue uma antes de ligar outra.",
        )}`,
      );
      return;
    }
    // A marca nasce ESCRITA: ver o cabeçalho — a declaração do servidor abre a
    // opção `leitura`, não a escolhe.
    onChangeToolIds(marcarRemota(toolIds, opcao.nome, "escrita"));
  }

  function trocarMarca(opcao: OpcaoRemotaParaOEditor, marca: MarcaRemota) {
    onChangeToolIds(marcarRemota(toolIds, opcao.nome, marca));
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Switch
          id="mcp_externo_no_atendimento"
          checked={ligado}
          onCheckedChange={alternar}
          disabled={disabled || salvando}
        />
        <Label htmlFor="mcp_externo_no_atendimento">
          {t("Usar o servidor de ferramentas externo durante o atendimento")}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "O servidor recebe a identidade do cliente da conversa e deve filtrar os dados por ela.",
        )}
      </p>

      {ligado ? (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">{t("Ferramentas deste servidor")}</h4>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void carregar()}
              disabled={disabled || carregando}
              data-testid="recarregar-ferramentas"
            >
              {carregando ? t("Consultando…") : t("Recarregar a lista")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Marque o que este agente pode usar. A marca de leitura ou escrita é sua: o servidor pode declarar leitura, mas quem decide é você.",
            )}
          </p>
          <p data-testid="aviso-escrita-na-conversa" className="text-xs text-muted-foreground">
            {t(
              "Ferramenta marcada como escrita não roda durante a conversa com o cliente: para consultas, escolha Leitura.",
            )}
          </p>

          {erro ? (
            <p
              role="alert"
              data-testid="erro-do-servidor"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {erro}{" "}
              <span data-testid="erro-preserva-o-salvo">
                {t("As ferramentas já marcadas nesta versão continuam como estão.")}
              </span>
            </p>
          ) : null}

          {carregando && ferramentas === null ? (
            <p className="text-sm text-muted-foreground">
              {t("Consultando as ferramentas do servidor…")}
            </p>
          ) : null}

          {recusa ? (
            <p
              role="alert"
              data-testid="recusa-teto"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {recusa}
            </p>
          ) : null}

          {ferramentas !== null && ferramentas.length === 0 ? (
            <p data-testid="servidor-sem-ferramentas" className="text-sm text-muted-foreground">
              {t("O servidor não anunciou nenhuma ferramenta.")}
            </p>
          ) : null}

          {ferramentas !== null && ferramentas.length > 0 ? (
            <ul data-testid="ferramentas-do-servidor" className="flex flex-col gap-1">
              {ferramentas.map((opcao) => {
                const marca = marcaDaRemota(toolIds, opcao.nome);
                return (
                  <li
                    key={opcao.nome}
                    data-testid={`ferramenta-${opcao.nome}`}
                    data-marcada={marca === null ? "nao" : "sim"}
                    className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                      data-testid={`marcar-${opcao.nome}`}
                      checked={marca !== null}
                      onChange={(e) => alternarFerramenta(opcao, e.target.checked)}
                      disabled={disabled}
                      aria-label={opcao.nome}
                    />
                    <span className="flex-1 space-y-1">
                      <code className="block font-medium">{opcao.nome}</code>
                      {opcao.descricao ? (
                        // Descrição vem do SERVIDOR REMOTO: dado de terceiro, não
                        // frase deste produto — por isso não passa por `t()`.
                        <span className="block text-xs text-muted-foreground">
                          {opcao.descricao}
                        </span>
                      ) : null}
                    </span>
                    {marca !== null ? (
                      <select
                        data-testid={`marca-${opcao.nome}`}
                        aria-label={`${t("Marca desta ferramenta")}: ${opcao.nome}`}
                        value={marca}
                        onChange={(e) => trocarMarca(opcao, e.target.value as MarcaRemota)}
                        disabled={disabled}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        {/*
                          `leitura` só aparece para ferramenta que o servidor
                          DECLAROU `readOnlyHint` — o runtime exige as duas
                          metades, e a action não gera o id sem a declaração. A
                          escolha de marcar leitura continua sendo do
                          administrador.
                        */}
                        {opcao.declaradaLeitura ? (
                          <option value="leitura">{t("Leitura")}</option>
                        ) : null}
                        <option value="escrita">{t("Escrita")}</option>
                      </select>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {orfas.length > 0 ? (
            <div
              data-testid="remotas-orfas"
              className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
            >
              <p>
                {t("O servidor não anuncia mais estas ferramentas marcadas")}:{" "}
                <code>{orfas.map((o) => o.nome).join(", ")}</code>.{" "}
                {t("Elas continuam na versão, mas o agente não consegue usá-las.")}
              </p>
              <button
                type="button"
                data-testid="remover-remotas-orfas"
                disabled={disabled}
                onClick={() => onChangeToolIds(removerRemotasOrfas(toolIds, anunciadas))}
                className="font-medium underline underline-offset-4 disabled:opacity-50"
              >
                {t("Tirar estas ferramentas da versão")}
              </button>
            </div>
          ) : null}
        </div>
      ) : escolhidas.length > 0 ? (
        <p
          data-testid="remotas-salvas-com-opcao-desligada"
          className="text-xs text-muted-foreground"
        >
          {escolhidas.length === 1
            ? t("Uma ferramenta do servidor externo continua marcada nesta versão.")
            : `${escolhidas.length} ${t(
                "ferramentas do servidor externo continuam marcadas nesta versão.",
              )}`}{" "}
          {t("Sem esta opção, elas não entram em atendimento por conversa.")}
        </p>
      ) : null}
    </Card>
  );
}
