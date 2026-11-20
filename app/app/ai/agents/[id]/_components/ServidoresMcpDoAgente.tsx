"use client";
/**
 * "Servidores MCP" — os servidores MCP externos DESTE agente (migration 9095).
 *
 * Lista, adiciona, edita, remove e testa. Para `oauth_por_contato` mostra o que
 * a descoberta achou (authorization server, escopos, registro dinâmico,
 * revogação) e as opções de retenção e de escrita delegada, com o risco escrito.
 * A ESCOLHA das ferramentas de cada servidor vai para o `tool_ids` da versão
 * (`mcp_externo:<servidor_id>:<marca>:<nome>`), pelo mesmo salvar do formulário
 * — as funções puras de `escolha-do-editor.ts` fazem a conta.
 *
 * Só `admin` vê (as actions recusam o resto). Segredo nunca volta: a tela vê o
 * `last4` da chave e se há `client_secret`.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  descobrirOauthDoServidor,
  listarFerramentasDoServidorMcpDoAgente,
  listarServidoresMcpDoAgente,
  removerServidorMcpDoAgente,
  salvarServidorMcpDoAgente,
  type ErroDaAcao,
  type ServidorNaTela,
} from "@/app/actions/agents/servidoresMcpDoAgente";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import {
  desmarcarRemota,
  desmarcarServidor,
  marcaDaRemota,
  marcarRemota,
} from "@/lib/mcp/servidor-externo/escolha-do-editor";
import { escolhasDoServidor, type MarcaRemota } from "@/lib/mcp/servidor-externo/ids";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";
import { randomId } from "@/lib/random-id";

type Modo = "nenhuma" | "chave_estatica" | "oauth_por_contato";

interface Props {
  agentId: string;
  toolIds: readonly string[];
  onChangeToolIds: (ids: string[]) => void;
  disabled?: boolean;
}

const MENSAGEM_DO_ERRO: Record<ErroDaAcao, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo para continuar.",
  forbidden_tenant: "Não foi possível identificar a empresa ativa desta sessão.",
  forbidden_role: "Só administradores gerenciam os servidores MCP do agente.",
  validation_failed: "Confira os campos: algum valor não foi aceito.",
  agente_inexistente: "Este agente não foi encontrado.",
  servidor_inexistente: "Este servidor não existe mais.",
  limite_de_servidores: "Este agente já tem o máximo de servidores MCP.",
  endpoint_inseguro: "Endereço recusado: use https, sem senha, sem parâmetros e sem endereço interno.",
  erro_ao_gravar: "Não foi possível gravar. Tente de novo.",
  modulo_desligado: "Quem administra o servidor desligou as ferramentas externas por agente.",
  descoberta_falhou: "O servidor não informou como autorizar (descoberta OAuth falhou).",
  sem_s256: "O servidor de autorização não aceita PKCE S256 — o cadastro foi recusado.",
  metadados_divergentes: "Os dados de autorização devolvidos são de outro endereço, não do servidor informado — o cadastro foi recusado.",
  sem_cliente: "Este servidor não aceita registro automático: informe o client_id.",
  registro_falhou: "O registro automático do cliente foi recusado pelo servidor.",
  invalid_grant: "O servidor recusou a autorização.",
  recusado: "O servidor recusou o pedido.",
  rede: "Não foi possível falar com o servidor.",
};

const ROTULO_DO_MODO: Record<Modo, string> = {
  nenhuma: "Sem autenticação",
  chave_estatica: "Chave fixa (Bearer)",
  oauth_por_contato: "OAuth — cada cliente autoriza com o login dele",
};
const MODOS: Modo[] = ["nenhuma", "chave_estatica", "oauth_por_contato"];

interface Formulario {
  nome: string;
  endpoint: string;
  modo: Modo;
  chave: string;
  oauthClientId: string;
  oauthClientSecret: string;
  escoposPedidos: string[];
  escritaDelegada: boolean;
  retencaoHoras: number;
  ativo: boolean;
}

const VAZIO: Formulario = {
  nome: "",
  endpoint: "",
  modo: "oauth_por_contato",
  chave: "",
  oauthClientId: "",
  oauthClientSecret: "",
  escoposPedidos: [],
  escritaDelegada: false,
  retencaoHoras: 0,
  ativo: true,
};

function doServidor(s: ServidorNaTela): Formulario {
  return {
    nome: s.nome,
    endpoint: s.endpoint,
    modo: s.modo,
    chave: "",
    oauthClientId: s.oauth?.cliente_dinamico ? "" : s.oauthClientId ?? "",
    oauthClientSecret: "",
    escoposPedidos: s.escoposPedidos,
    escritaDelegada: s.escritaDelegada,
    retencaoHoras: s.retencaoHoras,
    ativo: s.ativo,
  };
}

interface Descoberta {
  emissor: string;
  escopos: string[];
  temRegistroDinamico: boolean;
  temRevogacao: boolean;
  hosts: string[];
  redirectUri: string | null;
}

export function ServidoresMcpDoAgente({ agentId, toolIds, onChangeToolIds, disabled }: Props) {
  const t = useT();
  const [servidores, setServidores] = useState<ServidorNaTela[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  // `idNovo`: o id reservado para o servidor novo — o endereço de retorno é
  // por servidor, e o cadastro manual no terceiro precisa dele antes de salvar.
  const [editando, setEditando] = useState<{ id: string | null; idNovo: string; form: Formulario } | null>(null);
  const [descoberta, setDescoberta] = useState<Descoberta | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const recarregar = useCallback(async () => {
    // A action é rede: falha de transporte (ou teste sem request scope) vira
    // estado da tela, nunca rejeição não tratada.
    const r = await listarServidoresMcpDoAgente(agentId).catch(
      () => ({ ok: false, error: "rede" }) as const,
    );
    if (!r.ok) {
      setErro(t(MENSAGEM_DO_ERRO[r.error]));
      setServidores([]);
      return;
    }
    setErro(null);
    setServidores(r.data);
  }, [agentId, t]);

  useEffect(() => {
    // Carga inicial a partir de server action (sistema externo ao React).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void recarregar();
  }, [recarregar]);

  function abrir(s: ServidorNaTela | null) {
    setDescoberta(null);
    setErro(null);
    setEditando({ id: s?.id ?? null, idNovo: randomId(), form: s ? doServidor(s) : VAZIO });
  }

  function mudar(p: Partial<Formulario>) {
    setEditando((e) => (e ? { ...e, form: { ...e.form, ...p } } : e));
  }

  async function testar() {
    if (!editando) return;
    setOcupado(true);
    setErro(null);
    try {
      const r = await descobrirOauthDoServidor(agentId, editando.form.endpoint.trim(), editando.id ?? editando.idNovo);
      if (!r.ok) {
        setDescoberta(null);
        setErro(t(MENSAGEM_DO_ERRO[r.error]));
        return;
      }
      setDescoberta(r.data);
      if (editando.form.escoposPedidos.length === 0) mudar({ escoposPedidos: r.data.escopos });
    } finally {
      setOcupado(false);
    }
  }

  async function salvar() {
    if (!editando) return;
    setOcupado(true);
    setErro(null);
    try {
      const r = await salvarServidorMcpDoAgente(agentId, editando.id, {
        ...editando.form,
        nome: editando.form.nome.trim(),
        endpoint: editando.form.endpoint.trim(),
      }, editando.id ? undefined : editando.idNovo);
      if (!r.ok) {
        setErro(t(MENSAGEM_DO_ERRO[r.error]));
        return;
      }
      toast.success(t("Servidor MCP salvo."));
      setEditando(null);
      setDescoberta(null);
      await recarregar();
    } finally {
      setOcupado(false);
    }
  }

  async function remover(s: ServidorNaTela) {
    setOcupado(true);
    try {
      const r = await removerServidorMcpDoAgente(agentId, s.id);
      if (!r.ok) {
        setErro(t(MENSAGEM_DO_ERRO[r.error]));
        return;
      }
      // As escolhas desse servidor saem do `tool_ids` em edição (vão no próximo salvar).
      onChangeToolIds(desmarcarServidor(toolIds, s.id));
      toast.success(t("Servidor MCP removido. Os acessos dos clientes a ele foram revogados."));
      await recarregar();
    } finally {
      setOcupado(false);
    }
  }

  const f = editando?.form;
  const enderecoDeRetorno =
    servidores?.find((s) => s.id === editando?.id)?.redirectUri ?? descoberta?.redirectUri ?? null;
  const escoposOferecidos = [...new Set([...(descoberta?.escopos ?? []), ...(f?.escoposPedidos ?? [])])];
  const limiteAtingido = (servidores?.length ?? 0) >= 5;

  return (
    <Card className="space-y-3 p-4" data-testid="servidores-mcp-do-agente">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t("Servidores MCP do agente")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("Sistemas externos que este agente consulta. No modo OAuth, cada cliente autoriza o acesso à própria conta pelo link que o agente envia na conversa.")}
          </p>
        </div>
        {!editando ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => abrir(null)}
            disabled={disabled || limiteAtingido}
            data-testid="adicionar-servidor-mcp"
          >
            {t("Adicionar servidor")}
          </Button>
        ) : null}
      </div>

      {erro ? (
        <p role="alert" data-testid="erro-servidor-mcp" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {erro}
        </p>
      ) : null}

      {servidores === null ? <p className="text-sm text-muted-foreground">{t("Carregando…")}</p> : null}

      {servidores !== null && servidores.length === 0 && !editando ? (
        <p className="text-sm text-muted-foreground" data-testid="sem-servidores-mcp">
          {t("Nenhum servidor MCP cadastrado neste agente.")}
        </p>
      ) : null}

      {!editando && servidores && servidores.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {servidores.map((s) => (
            <ServidorNaLista
              key={s.id}
              agentId={agentId}
              servidor={s}
              toolIds={toolIds}
              onChangeToolIds={onChangeToolIds}
              disabled={disabled || ocupado}
              onEditar={() => abrir(s)}
              onRemover={() => void remover(s)}
            />
          ))}
        </ul>
      ) : null}

      {editando && f ? (
        <div className="space-y-3 border-t border-border pt-3" data-testid="formulario-servidor-mcp">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="mcp-nome">{t("Nome de exibição")}</Label>
              <Input id="mcp-nome" value={f.nome} maxLength={80} onChange={(e) => mudar({ nome: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mcp-modo">{t("Autenticação")}</Label>
              <select
                id="mcp-modo"
                data-testid="modo-servidor-mcp"
                value={f.modo}
                onChange={(e) => {
                  setDescoberta(null);
                  mudar({ modo: e.target.value as Modo, escritaDelegada: false });
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm max-md:min-h-11"
              >
                {MODOS.map((m) => (
                  <option key={m} value={m}>
                    {t(ROTULO_DO_MODO[m])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-endpoint">{t("Endereço do servidor (Streamable HTTP)")}</Label>
            <Input
              id="mcp-endpoint"
              type="url"
              placeholder="https://…/mcp"
              value={f.endpoint}
              onChange={(e) => {
                setDescoberta(null);
                mudar({ endpoint: e.target.value });
              }}
            />
          </div>

          {f.modo === "chave_estatica" ? (
            <div className="space-y-1">
              <Label htmlFor="mcp-chave">{t("Chave de acesso")}</Label>
              <Input
                id="mcp-chave"
                type="password"
                // "new-password": o navegador NÃO preenche com a senha salva do CRM
                // (o "off" é ignorado em campo de senha — medido na VPS).
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                placeholder={
                  editando.id && servidores?.find((s) => s.id === editando.id)?.chaveLast4
                    ? `•••• ${servidores.find((s) => s.id === editando.id)?.chaveLast4} — ${t("deixe em branco para manter")}`
                    : ""
                }
                value={f.chave}
                onChange={(e) => mudar({ chave: e.target.value })}
              />
            </div>
          ) : null}

          {f.modo === "oauth_por_contato" ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void testar()} disabled={ocupado || f.endpoint.trim() === ""} data-testid="testar-servidor-mcp">
                  {ocupado ? t("Consultando…") : t("Testar conexão")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("Valida a descoberta OAuth (RFC 9728 e 8414) e se o servidor aceita PKCE S256.")}
                </span>
              </div>
              {descoberta ? (
                <dl className="grid gap-1 text-xs" data-testid="resultado-descoberta">
                  <div>
                    <dt className="inline font-medium">{t("Servidor de autorização")}: </dt>
                    <dd className="inline"><code>{descoberta.emissor}</code></dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">{t("Registro automático do cliente")}: </dt>
                    <dd className="inline">{descoberta.temRegistroDinamico ? t("sim") : t("não — informe o client_id")}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">{t("Revogação de acesso")}: </dt>
                    <dd className="inline">{descoberta.temRevogacao ? t("sim") : t("não — o acesso é apagado só do lado de cá")}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">{t("Hosts que este servidor alcança")}: </dt>
                    <dd className="inline"><code>{descoberta.hosts.join(", ")}</code></dd>
                  </div>
                </dl>
              ) : null}

              {escoposOferecidos.length > 0 ? (
                <fieldset className="space-y-1">
                  <legend className="text-xs font-medium">{t("Escopos pedidos ao cliente")}</legend>
                  <div className="flex flex-wrap gap-2">
                    {escoposOferecidos.map((e) => (
                      <label key={e} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs max-md:min-h-11">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={f.escoposPedidos.includes(e)}
                          onChange={(ev) =>
                            mudar({
                              escoposPedidos: ev.target.checked
                                ? [...f.escoposPedidos, e]
                                : f.escoposPedidos.filter((x) => x !== e),
                            })
                          }
                        />
                        <code>{e}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <details className="text-xs">
                <summary className="cursor-pointer font-medium max-md:min-h-11 max-md:py-3.5">{t("Cliente OAuth manual (opcional)")}</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="mcp-client-id">client_id</Label>
                    <Input id="mcp-client-id" value={f.oauthClientId} onChange={(e) => mudar({ oauthClientId: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="mcp-client-secret">client_secret</Label>
                    <Input id="mcp-client-secret" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={f.oauthClientSecret} onChange={(e) => mudar({ oauthClientSecret: e.target.value })} />
                  </div>
                  <p className="text-muted-foreground sm:col-span-2">
                    {enderecoDeRetorno ? (
                      <>
                        {t("Endereço de retorno para cadastrar no servidor de autorização")}:{" "}
                        <code data-testid="endereco-de-retorno-mcp">{enderecoDeRetorno}</code>
                      </>
                    ) : (
                      t("Clique em Testar conexão para ver o endereço de retorno deste servidor.")
                    )}
                  </p>
                </div>
              </details>

              <div className="space-y-1">
                <Label htmlFor="mcp-retencao">{t("Manter o acesso depois que a conversa encerra (horas)")}</Label>
                <Input
                  id="mcp-retencao"
                  type="number"
                  min={0}
                  max={720}
                  className="w-28"
                  value={f.retencaoHoras}
                  onChange={(e) => mudar({ retencaoHoras: Math.max(0, Math.min(720, Number(e.target.value) || 0)) })}
                />
                <p className="text-xs text-muted-foreground">{t("0 = o acesso é revogado assim que a conversa é encerrada.")}</p>
              </div>

              <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2">
                  <Switch
                    id="mcp-escrita-delegada"
                    checked={f.escritaDelegada}
                    onCheckedChange={(v) => mudar({ escritaDelegada: v })}
                    data-testid="escrita-delegada"
                  />
                  <Label htmlFor="mcp-escrita-delegada">{t("Permitir ações (escrita) durante a conversa")}</Label>
                </div>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("Ligado, as ferramentas que você marcar como Escrita podem agir na conta do cliente (ligar um aparelho, alterar um pedido) durante a conversa, com o acesso que ele mesmo autorizou. O agente pode errar: ligue só para ações que o cliente pediria a um atendente, e confira a auditoria.")}
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Switch id="mcp-ativo" checked={f.ativo} onCheckedChange={(v) => mudar({ ativo: v })} />
            <Label htmlFor="mcp-ativo">{t("Servidor ativo")}</Label>
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={() => void salvar()} disabled={ocupado || f.nome.trim() === "" || f.endpoint.trim() === ""} data-testid="salvar-servidor-mcp">
              {ocupado ? t("Salvando…") : t("Salvar servidor")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditando(null)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function ServidorNaLista({
  agentId,
  servidor,
  toolIds,
  onChangeToolIds,
  disabled,
  onEditar,
  onRemover,
}: {
  agentId: string;
  servidor: ServidorNaTela;
  toolIds: readonly string[];
  onChangeToolIds: (ids: string[]) => void;
  disabled?: boolean;
  onEditar: () => void;
  onRemover: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [lista, setLista] = useState<Array<{ name: string; description?: string; somenteLeitura?: boolean }> | null>(null);
  const [origem, setOrigem] = useState<"servidor" | "vistas_em_turnos" | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [confirmarRemocao, setConfirmarRemocao] = useState(false);

  const escolhidas = escolhasDoServidor(toolIds, servidor.id);

  async function carregar() {
    setErro(null);
    const r = await listarFerramentasDoServidorMcpDoAgente(agentId, servidor.id);
    if (!r.ok) {
      setErro(t(MENSAGEM_DO_ERRO[r.error]));
      setLista(null);
      return;
    }
    setOrigem(r.data.origem);
    setLista(r.data.ferramentas);
  }

  function alternar(nome: string, marcada: boolean) {
    if (!marcada) return onChangeToolIds(desmarcarRemota(toolIds, nome, servidor.id));
    if (toolIds.length >= TETO_TOOLS_POR_AGENTE) {
      setErro(`${t("Você já ligou")} ${TETO_TOOLS_POR_AGENTE} ${t("capacidades. Desligue uma antes de ligar outra.")}`);
      return;
    }
    onChangeToolIds(marcarRemota(toolIds, nome, "escrita", servidor.id));
  }

  // O que mostrar: o anunciado + o já escolhido (uma escolha salva continua
  // visível mesmo que nenhum turno a tenha visto ainda).
  const nomes = new Map<string, { description?: string; somenteLeitura?: boolean }>();
  for (const f of lista ?? []) nomes.set(f.name, f);
  for (const e of escolhidas) if (!nomes.has(e.nome)) nomes.set(e.nome, {});

  return (
    <li className="rounded-md border border-border p-3" data-testid={`servidor-mcp-${servidor.slug}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {servidor.nome} {!servidor.ativo ? <span className="text-xs text-muted-foreground">({t("inativo")})</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(ROTULO_DO_MODO[servidor.modo])} · <code>{servidor.hosts[0]}</code> · {escolhidas.length} {t("ferramentas marcadas")}
            {servidor.escritaDelegada ? ` · ${t("ações permitidas na conversa")}` : ""}
          </p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setAberto(!aberto); if (!aberto && lista === null) void carregar(); }} data-testid={`ferramentas-servidor-${servidor.slug}`}>
            {t("Ferramentas")}
          </Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onEditar}>
            {t("Editar")}
          </Button>
          {confirmarRemocao ? (
            <Button size="sm" variant="destructive" disabled={disabled} onClick={onRemover} data-testid={`confirmar-remover-${servidor.slug}`}>
              {t("Confirmar remoção")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirmarRemocao(true)}>
              {t("Remover")}
            </Button>
          )}
        </div>
      </div>

      {aberto ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {servidor.modo === "oauth_por_contato" ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t("Este servidor só lista as ferramentas com o acesso de um cliente. A lista abaixo é o que já apareceu em conversas; você também pode escrever o nome de uma ferramenta.")}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="acesso-e-automatico">
                {t("O link de autorização é automático: enquanto o cliente não autorizar, o agente recebe sozinho a ferramenta que gera o link. Não é preciso marcá-la aqui.")}
              </p>
            </>
          ) : null}
          {erro ? <p role="alert" className="text-xs text-destructive">{erro}</p> : null}
          {lista !== null && nomes.size === 0 ? (
            <p className="text-xs text-muted-foreground">
              {origem === "vistas_em_turnos" ? t("Nenhuma ferramenta vista ainda.") : t("O servidor não anunciou nenhuma ferramenta.")}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {[...nomes.entries()].map(([nome, info]) => {
              const marca = marcaDaRemota(toolIds, nome, servidor.id);
              return (
                <li key={nome} className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2" data-testid={`ferramenta-mcp-${servidor.slug}-${nome}`}>
                  {/* O label leva o toque do nome para a caixa: sozinha ela tem 16px. */}
                  <label className="flex flex-1 cursor-pointer items-start gap-3 max-md:min-h-11">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0 accent-primary"
                      checked={marca !== null}
                      onChange={(e) => alternar(nome, e.target.checked)}
                      disabled={disabled}
                      aria-label={nome}
                    />
                    <span className="flex-1 space-y-1">
                      <code className="block font-medium">{`${servidor.slug}__${nome}`}</code>
                      {info.description ? <span className="block text-xs text-muted-foreground">{info.description}</span> : null}
                    </span>
                  </label>
                  {marca !== null ? (
                    <select
                      aria-label={`${t("Marca desta ferramenta")}: ${nome}`}
                      value={marca}
                      onChange={(e) => onChangeToolIds(marcarRemota(toolIds, nome, e.target.value as MarcaRemota, servidor.id))}
                      disabled={disabled}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs max-md:min-h-11"
                    >
                      {info.somenteLeitura !== false ? <option value="leitura">{t("Leitura")}</option> : null}
                      <option value="escrita">{t("Escrita")}</option>
                    </select>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {servidor.modo === "oauth_por_contato" ? (
            <div className="flex gap-2">
              <Input
                value={manual}
                placeholder={t("nome_da_ferramenta")}
                onChange={(e) => setManual(e.target.value)}
                className="h-8 max-w-xs md:text-xs"
                aria-label={t("Nome da ferramenta")}
              />
              <Button
                size="sm"
                variant="outline"
                // `solicitar_acesso_*` é a ferramenta que o Deskcomm cria sozinho:
                // marcá-la como do servidor só gasta uma vaga do teto.
                disabled={disabled || !/^[A-Za-z0-9_-]{1,64}$/.test(manual) || manual.startsWith("solicitar_acesso_")}
                onClick={() => {
                  alternar(manual, true);
                  setManual("");
                }}
              >
                {t("Adicionar ferramenta")}
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {servidor.escritaDelegada
              ? t("Leitura só vale quando o servidor também declara a ferramenta como leitura. Escrita roda na conversa com o acesso do cliente.")
              : t("Leitura só vale quando o servidor também declara a ferramenta como leitura. Escrita não roda durante a conversa com o cliente.")}
          </p>
        </div>
      ) : null}
    </li>
  );
}
