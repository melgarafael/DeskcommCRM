"use client";

import { useId, useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

import {
  previewReceita,
  salvarReceitas,
  sugerirCamposACF,
  useReceitasDaConexao,
} from "@/hooks/external-db/useReceitasDaConexao";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";
import { RECEITAS, receitaDe } from "@/lib/external-db/receitas/registro";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";
import type { DefinicaoDeReceita } from "@/lib/external-db/receitas/tipos";

interface Props {
  connectionId: string;
  /** Só mostra para conexão mysql. */
  motor: "mysql" | "postgres";
  /** Só o administrador edita; os demais só leem. */
  canWrite: boolean;
}

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const POST_TYPE_PADRAO = "imovel";
const POST_TYPE_REGEX = /^[a-z0-9_\-]{1,20}$/;
const BUSCA_PADRAO = { limite: 5 };

const CAMPOS_ACF: { chave: string; rotulo: string }[] = [
  { chave: "preco", rotulo: "Preço" },
  { chave: "quartos", rotulo: "Quartos" },
  { chave: "bairro", rotulo: "Bairro" },
  { chave: "cidade", rotulo: "Cidade" },
  { chave: "area", rotulo: "Área" },
];

function fixosPadraoAcf(): InstanciaDeReceita["fixos"] {
  return {
    prefixo: PREFIXO_PADRAO,
    post_type: POST_TYPE_PADRAO,
    campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
  };
}

function receitasDisponiveis(motor: "mysql" | "postgres"): DefinicaoDeReceita[] {
  return [...RECEITAS.values()].filter((r) => r.motores.includes(motor));
}

export default function ReceitasProntas({ connectionId, motor, canWrite }: Props) {
  const t = useT();
  const query = useReceitasDaConexao(connectionId);
  const idInputRotulo = useId();
  const idInputDescricao = useId();
  const idInputPrefixo = useId();
  const idInputPostType = useId();
  const idInputSugerir = useId();
  const idBaseAcf = useId();

  // IDs de label para os campos ACF de mapeamento, derivados de um useId base.
  const idsCamposAcf: Record<string, string> = {};
  for (const c of CAMPOS_ACF) {
    idsCamposAcf[c.chave] = `${idBaseAcf}-${c.chave}`;
  }

  // Uma linha em edição (rascunho local, ainda não salvo). A lista completa
  // sempre deriva do servidor (query.data) + o rascunho em edição, então
  // acompanha o servidor após cada refetch sem setState síncrono em efeito.
  const [rascunho, setRascunho] = useState<InstanciaDeReceita | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  } | null>(null);
  const [previewando, setPreviewando] = useState(false);
  const [sugerindo, setSugerindo] = useState(false);

  const lista = useMemo(() => {
    const base = [...(query.data?.receitas ?? [])];
    if (rascunho) {
      const idx = base.findIndex((i) => i.id === rascunho.id);
      if (idx >= 0) base[idx] = rascunho;
      else base.push(rascunho);
    }
    return base;
  }, [query.data, rascunho]);

  const receitas = lista;
  const jaCadastradas = new Set(receitas.map((r) => r.receita));
  const opcoes = receitasDisponiveis(motor).filter((r) => !jaCadastradas.has(r.id));

  const salvar = async () => {
    if (!canWrite) return;
    try {
      await salvarReceitas(connectionId, lista);
      toast.success(t("Salvo."));
      setRascunho(null);
      await query.refetch();
    } catch (err) {
      showApiError(err);
    }
  };

  const adicionar = () => {
    if (!canWrite) return;
    const primeira = opcoes[0];
    if (!primeira) return;
    const receita = receitaDe(primeira.id);
    const nova: InstanciaDeReceita = {
      id: randomId(),
      receita: primeira.id,
      rotulo: receita?.rotulo ?? primeira.id,
      descricao: receita?.descricao ?? "",
      fixos: primeira.id === "acf-imoveis" ? fixosPadraoAcf() : { prefixo: PREFIXO_PADRAO },
      ativa: true,
    };
    setRascunho(nova);
  };

  const editar = (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setRascunho(inst);
  };

  const remover = async (id: string) => {
    if (!canWrite) return;
    setConfirmandoRemocao(id);
  };

  const confirmarRemocao = async () => {
    if (!confirmandoRemocao) return;
    const prox = lista.filter((i) => i.id !== confirmandoRemocao);
    setConfirmandoRemocao(null);
    try {
      await salvarReceitas(connectionId, prox);
      await query.refetch();
    } catch (err) {
      showApiError(err);
    }
  };

  const cancelarRemocao = () => {
    setConfirmandoRemocao(null);
  };

  const executarPreview = async (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setPreviewando(true);
    try {
      const resultado = await previewReceita(connectionId, inst.id, BUSCA_PADRAO);
      setPreview(resultado);
    } catch (err) {
      showApiError(err);
      setPreview(null);
    } finally {
      setPreviewando(false);
    }
  };

  /** Chama a rota de sugestão e preenche os campos vazios, sem sobrescrever o já digitado. */
  const sugerirCampos = async () => {
    if (!canWrite || !rascunho) return;
    const fixos = rascunho.fixos as {
      prefixo?: string;
      post_type?: string;
      campos?: Record<string, string>;
    };
    if (!fixos.prefixo || !fixos.post_type) {
      toast.error(t("Preencha o prefixo e o tipo de post antes de sugerir."));
      return;
    }
    setSugerindo(true);
    try {
      const sugerido = await sugerirCamposACF(connectionId, fixos.prefixo, fixos.post_type);
      const mapeamento = sugerido.mapeamento_sugerido as Record<string, string | null>;
      const camposAtuais = { ...(fixos.campos ?? {}) };
      for (const [campo, metaKey] of Object.entries(mapeamento)) {
        // Não sobrescreve o que o admin já digitou.
        if (metaKey && !camposAtuais[campo]) {
          camposAtuais[campo] = metaKey;
        }
      }
      const prox: InstanciaDeReceita = {
        ...rascunho,
        fixos: { ...fixos, campos: camposAtuais },
      };
      setRascunho(prox);
      if (sugerido.aviso) {
        toast.warning(sugerido.aviso);
      } else {
        toast.success(t("Campos sugeridos preenchidos."));
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setSugerindo(false);
    }
  };

  if (motor !== "mysql") return null;
  if (opcoes.length === 0 && receitas.length === 0) return null;

  // Query falhou: nunca fica em silêncio (Living System, item 1). Mostra mensagem
  // legível com botão para tentar de novo.
  if (query.isError) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("Não foi possível carregar as receitas.")}{" "}
        <Button size="sm" onClick={() => query.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">{t("Receitas prontas")}</CardTitle>
        {canWrite && opcoes.length > 0 && (
          <Button size="sm" onClick={adicionar}>
            {t("Adicionar receita")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!query.data && (
          <p className="text-sm text-muted-foreground">{t("Carregando receitas…")}</p>
        )}
        {query.data && receitas.length === 0 && canWrite && (
          <p className="text-sm text-muted-foreground">
            {t(
              "Nenhuma receita cadastrada ainda. Adicione uma para o assistente consultar o banco de origem.",
            )}
          </p>
        )}

        {receitas.map((inst) => {
          const receita = receitaDe(inst.receita);
          const editandoEsta = rascunho?.id === inst.id;
          const fixos = inst.fixos as {
            prefixo?: string;
            post_type?: string;
            campos?: Record<string, string>;
          };
          const cols = fixos.prefixo ?? PREFIXO_PADRAO;

          if (editandoEsta && canWrite) {
            const ehAcf = receita?.id === "acf-imoveis";
            return (
              <Card key={inst.id} className="mb-2 border border-border p-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="col-span-1 md:col-span-2">
                    <Label htmlFor={idInputRotulo} className="text-xs text-muted-foreground">
                      {t("Rótulo")}
                    </Label>
                    <Input
                      id={idInputRotulo}
                      value={inst.rotulo}
                      onChange={(e) => {
                        const prox = { ...inst, rotulo: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={idInputDescricao} className="text-xs text-muted-foreground">
                      {t("Descrição")}
                    </Label>
                    <Input
                      id={idInputDescricao}
                      value={inst.descricao}
                      onChange={(e) => {
                        const prox = { ...inst, descricao: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={idInputPrefixo} className="text-xs text-muted-foreground">
                      {t("Prefixo das tabelas")}
                    </Label>
                    <Input
                      id={idInputPrefixo}
                      value={cols}
                      onChange={(e) => {
                        const valor = e.target.value;
                        if (!PREFIXO_REGEX.test(valor)) return;
                        const prox = { ...inst, fixos: { ...fixos, prefixo: valor } };
                        setRascunho(prox);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("O prefixo aparece antes de _posts no banco do WordPress (padrão wp_).")}
                    </p>
                  </div>
                  {ehAcf && (
                    <div>
                      <Label htmlFor={idInputPostType} className="text-xs text-muted-foreground">
                        {t("Tipo de post")}
                      </Label>
                      <Input
                        id={idInputPostType}
                        value={fixos.post_type ?? POST_TYPE_PADRAO}
                        onChange={(e) => {
                          const valor = e.target.value;
                          if (!POST_TYPE_REGEX.test(valor)) return;
                          const prox = { ...inst, fixos: { ...fixos, post_type: valor } };
                          setRascunho(prox);
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("Qual tipo de post do WordPress (padrão imovel).")}
                      </p>
                    </div>
                  )}
                  <div className="col-span-1 flex items-end md:col-span-1">
                    <Switch
                      checked={inst.ativa}
                      onCheckedChange={(ativa) => {
                        const prox = { ...inst, ativa };
                        setRascunho(prox);
                      }}
                    />
                    <Label className="ml-2 text-xs text-muted-foreground">{t("Ativa")}</Label>
                  </div>
                </div>

                {ehAcf && (
                  <div className="mt-2 border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("Mapeamento de campos (meta_key)")}
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {CAMPOS_ACF.map((c) => {
                        const idInput = idsCamposAcf[c.chave];
                        const valorAtual = fixos.campos?.[c.chave] ?? "";
                        const obrigatorio = c.chave !== "cidade" && c.chave !== "area";
                        return (
                          <div key={c.chave} className="col-span-1">
                            <Label
                              htmlFor={idInput}
                              className={`text-xs text-muted-foreground ${obrigatorio ? "font-medium" : ""}`}
                            >
                              {t(c.rotulo)}
                              {obrigatorio ? " *" : ""}
                            </Label>
                            <Input
                              id={idInput}
                              value={valorAtual}
                              onChange={(e) => {
                                const valor = e.target.value;
                                if (!/^[A-Za-z0-9_\-]{1,64}$/.test(valor) && valor !== "") return;
                                const proxCampos = { ...fixos.campos, [c.chave]: valor };
                                const prox = { ...inst, fixos: { ...fixos, campos: proxCampos } };
                                setRascunho(prox);
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex items-end gap-2">
                      <Button
                        size="sm"
                        onClick={sugerirCampos}
                        disabled={sugerindo}
                        id={idInputSugerir}
                      >
                        {sugerindo ? t("Sugerindo…") : t("Sugerir campos")}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t("Preenche só os campos ainda vazios; a palavra final é sua.")}
                      </p>
                    </div>
                  </div>
                )}

                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={salvar}>
                    {t("Salvar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRascunho(null)}>
                    {t("Cancelar")}
                  </Button>
                  <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                    {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                  </Button>
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {preview && preview.instancia.id === inst.id && (
                  <div className="mt-3 border-t pt-2">
                    <p className="mb-1 text-xs text-muted-foreground">
                      {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas}{" "}
                      {t("linhas")}
                      {preview.truncado ? ` · ${t("truncado")}` : ""}
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs font-medium">
                                {c}
                              </TableCell>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.linhas.map((linha, i) => (
                            <TableRow key={i}>
                              {preview.colunas.map((c) => (
                                <TableCell key={c} className="text-xs">
                                  {String(linha[c] ?? "")}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </Card>
            );
          }

          return (
            <Card key={inst.id} className="mb-2 border border-border p-3">
              <div className="flex flex-row items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {inst.rotulo || (receita?.rotulo ?? inst.receita)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {inst.descricao || (receita?.descricao ?? "")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("Prefixo:")} <span className="font-mono">{cols}</span>
                  </p>
                  {ehAcfInstance(receita) && (
                    <p className="text-xs text-muted-foreground">
                      {t("Tipo de post:")}{" "}
                      <span className="font-mono">{fixos.post_type ?? POST_TYPE_PADRAO}</span>
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Badge variant={inst.ativa ? "success" : "secondary"}>
                    {inst.ativa ? t("Ativa") : t("Inativa")}
                  </Badge>
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => editar(inst)}>
                      {t("Editar")}
                    </Button>
                  )}
                  {canWrite && (
                    <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                      {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                    </Button>
                  )}
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {preview && preview.instancia.id === inst.id && (
                <div className="mt-3 border-t pt-2">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas}{" "}
                    {t("linhas")}
                    {preview.truncado ? ` · ${t("truncado")}` : ""}
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {preview.colunas.map((c) => (
                            <TableCell key={c} className="text-xs font-medium">
                              {c}
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.linhas.map((linha, i) => (
                          <TableRow key={i}>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs">
                                {String(linha[c] ?? "")}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ehAcfInstance(receita: DefinicaoDeReceita | undefined): boolean {
  return receita?.id === "acf-imoveis";
}
