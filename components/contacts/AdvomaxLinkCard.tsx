"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { advomaxProcessUrl } from "@/lib/advomax/navigation";
import { useConfirm } from "@/components/ui/confirm-provider";
import { cn } from "@/lib/utils";

type LinkRow = { id: string; pessoa_codigo: number; status: "pending" | "linked" | "conflict" | "unlinked"; pessoa?: { nome: string; tipoPessoa: string; cliente: boolean } | null; pessoa_resumo_indisponivel?: boolean };
type PessoaRow = { codigo: number; nome: string; tipoPessoa: string; email: string | null; telefone: string | null };
type ProcessoRow = { codigo: number; pasta: string | null; numero: string | null; status: number; ultimaMovimentacao: string | null; tribunal: string | null; tipoAcaoCodigo: number | null; tipoAcaoNome: string | null };
type ProcessoLinkRow = { id: string; processo_codigo: number; created_at: string; advomax_url: string | null };
type DocumentoRow = { codigo: number; nomeArquivo: string; descricao: string | null; data: string; tipo: string; origem: "whatsapp" | "advomax"; armazenadoNoDrive: boolean };
type ChecklistItem = { id: string; label: string; required: boolean; position: number; completed: boolean; completed_at: string | null };

export function AdvomaxLinkCard({ contactId, canManage = false }: { contactId: string; canManage?: boolean }) {
  const t = useT();
  const confirm = useConfirm();
  const [link, setLink] = useState<LinkRow | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busca, setBusca] = useState("");
  const [sugestoes, setSugestoes] = useState<PessoaRow[]>([]);
  const [processos, setProcessos] = useState<ProcessoRow[]>([]);
  const [processoSelecionado, setProcessoSelecionado] = useState<ProcessoRow | null>(null);
  const [tituloAtividade, setTituloAtividade] = useState("");
  const [descricaoAtividade, setDescricaoAtividade] = useState("");
  const [dataAtividade, setDataAtividade] = useState("");
  const [atividadeSalvando, setAtividadeSalvando] = useState(false);
  const [atividadeErro, setAtividadeErro] = useState<string | null>(null);
  const [atividadeCriada, setAtividadeCriada] = useState<number | null>(null);
  const [comunicacaoCarregando, setComunicacaoCarregando] = useState(false);
  const [comunicacaoErro, setComunicacaoErro] = useState<string | null>(null);
  const chaveAtividade = useRef<string | null>(null);

  async function abrirRascunhoComunicacao() {
    if (!processoSelecionado || comunicacaoCarregando) return;
    setComunicacaoCarregando(true); setComunicacaoErro(null);
    try {
      const query = new URLSearchParams({ processo_codigo: String(processoSelecionado.codigo) });
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/comunicacao-contexto?${query}`);
      const body = await response.json().catch(() => null);
      const destino = body?.data?.comunicacao?.destino;
      if (!response.ok || typeof destino !== "string") throw new Error(body?.error?.message || t("Não foi possível abrir o rascunho de comunicação."));
      window.open(destino, "_blank", "noopener,noreferrer");
    } catch (error) { setComunicacaoErro(error instanceof Error ? error.message : t("Não foi possível abrir o rascunho de comunicação.")); }
    finally { setComunicacaoCarregando(false); }
  }
  const [processoLinks, setProcessoLinks] = useState<ProcessoLinkRow[]>([]);
  const [novoProcessoCodigo, setNovoProcessoCodigo] = useState("");
  const [salvandoProcesso, setSalvandoProcesso] = useState(false);
  const [documentos, setDocumentos] = useState<DocumentoRow[]>([]);
  const [linkIndisponivel, setLinkIndisponivel] = useState(false);
  const [processosIndisponiveis, setProcessosIndisponiveis] = useState(false);
  const [processoLinksIndisponiveis, setProcessoLinksIndisponiveis] = useState(false);
  const [documentosIndisponiveis, setDocumentosIndisponiveis] = useState(false);
  const [linkCarregando, setLinkCarregando] = useState(true);
  const [processosCarregando, setProcessosCarregando] = useState(false);
  const [processoLinksCarregando, setProcessoLinksCarregando] = useState(false);
  const [documentosCarregando, setDocumentosCarregando] = useState(false);
  const [checklist, setChecklist] = useState<{ template: { id: string; name: string } | null; items: ChecklistItem[] }>({ template: null, items: [] });
  const [checklistCarregando, setChecklistCarregando] = useState(false);
  const [checklistErro, setChecklistErro] = useState<string | null>(null);
  const [modeloNome, setModeloNome] = useState("");
  const [modeloItens, setModeloItens] = useState("");
  const [tentativa, setTentativa] = useState(0);

  async function criarAtividade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!processoSelecionado || !tituloAtividade.trim() || atividadeSalvando) return;
    setAtividadeSalvando(true);
    setAtividadeErro(null);
    chaveAtividade.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/atividades`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processo_codigo: processoSelecionado.codigo, titulo: tituloAtividade.trim(),
          descricao: descricaoAtividade.trim() || undefined, data_limite: dataAtividade || undefined,
          chave_idempotencia: chaveAtividade.current }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Number.isSafeInteger(body?.data?.codigo)) {
        throw new Error(body?.error?.message || t("Não foi possível criar a atividade."));
      }
      setAtividadeCriada(body.data.codigo);
      chaveAtividade.current = null;
    } catch (error) {
      setAtividadeErro(error instanceof Error ? error.message : t("Não foi possível criar a atividade."));
    } finally { setAtividadeSalvando(false); }
  }

  useEffect(() => {
    let ativo = true;
    setLinkCarregando(true);
    setLinkIndisponivel(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link`).then(async (r) => {
      if (!r.ok) throw new Error("link indisponível");
      return r.json();
    }).then((body) => {
      if (!ativo) return;
      const value = body?.data as LinkRow | null | undefined;
      setLink(value ?? null);
      if (value) setCodigo(String(value.pessoa_codigo));
    }).catch(() => { if (ativo) setLinkIndisponivel(true); }).finally(() => { if (ativo) setLinkCarregando(false); });
    return () => { ativo = false; };
  }, [contactId, tentativa]);

  useEffect(() => {
    if (link?.status !== "linked") {
      setProcessos([]);
      setProcessoSelecionado(null);
      setProcessosCarregando(false);
      return;
    }
    let ativo = true;
    setProcessosCarregando(true);
    setProcessosIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/processos`).then(async (r) => {
      if (!r.ok) throw new Error("processos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setProcessos(Array.isArray(body?.data) ? body.data as ProcessoRow[] : []);
    }).catch(() => { if (ativo) setProcessosIndisponiveis(true); }).finally(() => { if (ativo) setProcessosCarregando(false); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (!processoSelecionado?.tipoAcaoCodigo) { setChecklist({ template: null, items: [] }); return; }
    let ativo = true;
    setChecklistCarregando(true); setChecklistErro(null);
    const query = new URLSearchParams({ processo_codigo: String(processoSelecionado.codigo), tipo_acao_codigo: String(processoSelecionado.tipoAcaoCodigo) });
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/checklist?${query}`).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível carregar o checklist."));
      return body;
    }).then((body) => { if (ativo) setChecklist(body.data); }).catch((error) => { if (ativo) setChecklistErro(error.message); })
      .finally(() => { if (ativo) setChecklistCarregando(false); });
    return () => { ativo = false; };
  }, [contactId, processoSelecionado, tentativa, t]);

  async function atualizarChecklist(item: ChecklistItem) {
    if (!processoSelecionado?.tipoAcaoCodigo) return;
    setChecklistErro(null);
    const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/checklist`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processo_codigo: processoSelecionado.codigo, tipo_acao_codigo: processoSelecionado.tipoAcaoCodigo, item_id: item.id, completed: !item.completed }) });
    const body = await response.json().catch(() => null);
    if (!response.ok) { setChecklistErro(body?.error?.message || t("Não foi possível atualizar o checklist.")); return; }
    setChecklist((current) => ({ ...current, items: current.items.map((row) => row.id === item.id ? { ...row, ...body.data } : row) }));
  }

  async function criarModeloChecklist() {
    if (!processoSelecionado?.tipoAcaoCodigo) return;
    const itens = modeloItens.split(/\r?\n/).map((label) => label.trim()).filter(Boolean).map((label) => ({ label, required: true }));
    if (!modeloNome.trim() || itens.length === 0) { setChecklistErro(t("Informe o nome e pelo menos um item.")); return; }
    const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/checklist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processo_codigo: processoSelecionado.codigo, tipo_acao_codigo: processoSelecionado.tipoAcaoCodigo, nome: modeloNome.trim(), itens }) });
    const body = await response.json().catch(() => null);
    if (!response.ok) { setChecklistErro(body?.error?.message || t("Não foi possível criar o modelo.")); return; }
    setModeloNome(""); setModeloItens(""); setTentativa((value) => value + 1);
  }

  useEffect(() => {
    if (link?.status !== "linked") { setProcessoLinks([]); setProcessoLinksIndisponiveis(false); setProcessoLinksCarregando(false); return; }
    let ativo = true;
    setProcessoLinksCarregando(true);
    setProcessoLinksIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links`).then(async (r) => {
      if (!r.ok) throw new Error("vínculos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setProcessoLinks(Array.isArray(body?.data) ? body.data as ProcessoLinkRow[] : []);
    }).catch(() => { if (ativo) setProcessoLinksIndisponiveis(true); }).finally(() => { if (ativo) setProcessoLinksCarregando(false); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (link?.status !== "linked") { setDocumentos([]); setDocumentosCarregando(false); return; }
    let ativo = true;
    setDocumentosCarregando(true);
    setDocumentosIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/documentos`).then(async (r) => {
      if (!r.ok) throw new Error("documentos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setDocumentos(Array.isArray(body?.data) ? body.data as DocumentoRow[] : []);
    }).catch(() => { if (ativo) setDocumentosIndisponiveis(true); }).finally(() => { if (ativo) setDocumentosCarregando(false); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (!canManage || link?.status === "linked" || busca.trim().length < 2) return;
    let ativo = true;
    const timer = window.setTimeout(() => {
      void fetch(`/api/v1/advomax/pessoas?nome=${encodeURIComponent(busca.trim())}`).then((r) => r.ok ? r.json() : null).then((body) => {
        if (ativo) setSugestoes(Array.isArray(body?.data) ? body.data as PessoaRow[] : []);
      }).catch(() => undefined);
    }, 250);
    return () => { ativo = false; window.clearTimeout(timer); };
  }, [busca, canManage, link?.status]);

  async function vincular() {
    const pessoa = Number(codigo);
    if (!Number.isInteger(pessoa) || pessoa <= 0) { setErro(t("Informe o código da Pessoa no Advomax.")); return; }
    setSaving(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pessoa_codigo: pessoa }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível criar o vínculo."));
      setLink(body.data as LinkRow);
      setProcessoSelecionado(null);
      setSugestoes([]);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível criar o vínculo.")); }
    finally { setSaving(false); }
  }

  async function desvincular() {
    if (!canManage || !(await confirm(t("Desfazer o vínculo com o cadastro jurídico?")))) return;
    setSaving(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link`, { method: "DELETE" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível desfazer o vínculo."));
      setLink(body.data as LinkRow | null);
      setProcessos([]);
      setProcessoSelecionado(null);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível desfazer o vínculo.")); }
    finally { setSaving(false); }
  }

  async function vincularProcesso() {
    const processo = Number(novoProcessoCodigo);
    if (!Number.isSafeInteger(processo) || processo <= 0) { setErro(t("Informe um código de processo válido.")); return; }
    setSalvandoProcesso(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processo_codigo: processo }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível vincular o processo."));
      setProcessoLinks((atual) => [body.data as ProcessoLinkRow, ...atual]);
      setNovoProcessoCodigo("");
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível vincular o processo.")); }
    finally { setSalvandoProcesso(false); }
  }

  async function desvincularProcesso(processoCodigo: number) {
    if (!canManage || !(await confirm(t("Remover este processo dos vínculos do CRM?")))) return;
    setSalvandoProcesso(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links/${processoCodigo}`, { method: "DELETE" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível remover o vínculo."));
      setProcessoLinks((atual) => atual.filter((item) => item.processo_codigo !== processoCodigo));
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível remover o vínculo.")); }
    finally { setSalvandoProcesso(false); }
  }

  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">{t("Cadastro jurídico")}</h2><p className="text-sm text-muted-foreground">{t("Vincule este contato a uma Pessoa do Advomax para compartilhar contexto e documentos.")}</p></div>
      {link && <Badge variant={link.status === "linked" ? "success" : "warning"}>{link.status === "linked" ? t("Vinculado") : t("Aguardando confirmação")}</Badge>}
    </div>
    {linkCarregando && <Skeleton className="h-8 w-full" />}
    {!linkCarregando && !link && !linkIndisponivel && <p className="text-xs text-muted-foreground">{t("Este contato ainda não está vinculado a uma Pessoa do Advomax.")}</p>}
    {link?.status === "linked" && <div className="rounded border px-3 py-2 text-sm">
      <strong>{link.pessoa?.nome || `${t("Pessoa")} #${link.pessoa_codigo}`}</strong>
      {link.pessoa?.tipoPessoa && <span className="ml-2 text-muted-foreground">{link.pessoa.tipoPessoa}</span>}
      {link.pessoa_resumo_indisponivel && <p className="text-xs text-muted-foreground">{t("Resumo da Pessoa temporariamente indisponível.")}</p>}
    </div>}
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input value={busca} onChange={(e) => { setBusca(e.target.value); if (e.target.value.trim().length < 2) setSugestoes([]); }} placeholder={t("Buscar Pessoa ou cliente") } aria-label={t("Buscar Pessoa ou cliente") } disabled={!canManage || linkCarregando || link?.status === "linked"} />
      <Input inputMode="numeric" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder={t("Código da Pessoa") } aria-label={t("Código da Pessoa") } disabled={!canManage || linkCarregando} />
      <Button onClick={vincular} disabled={!canManage || linkCarregando || saving}>{saving ? t("Salvando…") : t("Vincular Pessoa")}</Button>
      {link?.status === "linked" && canManage && <Button variant="outline" onClick={desvincular} disabled={saving}>{t("Desvincular")}</Button>}
    </div>
    {sugestoes.length > 0 && <div className="space-y-1 rounded border p-2 text-sm">{sugestoes.map((pessoa) => <button type="button" key={pessoa.codigo} className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setCodigo(String(pessoa.codigo)); setBusca(pessoa.nome); setSugestoes([]); }}>
      <strong>{pessoa.nome}</strong><span className="ml-2 text-muted-foreground">#{pessoa.codigo}{pessoa.tipoPessoa && ` · ${pessoa.tipoPessoa}`}</span>
    </button>)}</div>}
    {!canManage && <p className="text-xs text-muted-foreground">{t("Somente gerentes podem confirmar este vínculo.")}</p>}
    {erro && <p role="alert" className="text-sm text-error-fg">{erro}</p>}
    {linkIndisponivel && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{t("Não foi possível carregar o vínculo com o Advomax.")}</span>
      <Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button>
    </div>}
    {link?.status === "linked" && <div className="border-t pt-3">
      <h3 className="text-sm font-semibold">{t("Processos da Pessoa")}</h3>
      {processosIndisponiveis && <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os processos estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
      {processosCarregando && <Skeleton className="mt-2 h-12 w-full" />}
      {!processosCarregando && !processosIndisponiveis && processos.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t("Nenhum processo ativo encontrado para esta Pessoa.")}</p>}
      {!processosCarregando && !processosIndisponiveis && processos.length > 0 && <ul className="mt-2 space-y-1 text-sm">{processos.map((processo) => {
        const selecionado = processoSelecionado?.codigo === processo.codigo;
        return <li key={processo.codigo} className={cn("flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5", selecionado && "border-primary bg-primary/5")}>
          <button type="button" className="min-w-0 flex-1 text-left" aria-pressed={selecionado} onClick={() => {
            setProcessoSelecionado(processo); setAtividadeCriada(null); setAtividadeErro(null); chaveAtividade.current = null;
          }}>
            <strong>{processo.pasta || processo.numero || `#${processo.codigo}`}</strong>{processo.tribunal && <span className="ml-2 text-muted-foreground">{processo.tribunal}</span>}
          </button>
          <a className="text-primary underline-offset-2 hover:underline" href={advomaxProcessUrl(processo.codigo)} target="_blank" rel="noreferrer">{t("Abrir ficha")}</a>
        </li>;
      })}</ul>}
      {processoSelecionado && <div className="mt-2 rounded-md border bg-muted/30 p-2 text-xs" data-testid="advomax-processo-selecionado">
        <div className="font-medium">{t("Processo selecionado")}: {processoSelecionado.pasta || processoSelecionado.numero || `#${processoSelecionado.codigo}`}</div>
        {processoSelecionado.numero && processoSelecionado.pasta && <div className="mt-0.5 text-muted-foreground">{processoSelecionado.numero}</div>}
        <div className="mt-1 text-muted-foreground">{processoSelecionado.tribunal || t("Tribunal não informado")} · {processoSelecionado.ultimaMovimentacao || t("Sem movimentação registrada")}</div>
        {processoSelecionado.tipoAcaoNome && <div className="mt-1 text-muted-foreground">{t("Tipo de ação")}: {processoSelecionado.tipoAcaoNome}</div>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void abrirRascunhoComunicacao()} disabled={comunicacaoCarregando}>
            {comunicacaoCarregando ? t("Abrindo…") : t("Preparar comunicação no Max")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("O Max gera um rascunho editável após sua confirmação")}</span>
        </div>
        {comunicacaoErro && <p role="alert" className="mt-1 text-error-fg">{comunicacaoErro}</p>}
        <div className="mt-3 border-t pt-3">
          <p className="font-semibold">{t("Checklist documental")}</p>
          {!processoSelecionado.tipoAcaoCodigo && <p className="mt-1 text-muted-foreground">{t("O processo não possui tipo de ação configurado no Advomax.")}</p>}
          {checklistCarregando && <Skeleton className="mt-2 h-10 w-full" />}
          {!checklistCarregando && checklist.template && <><p className="mt-1 text-muted-foreground">{checklist.template.name}</p><ul className="mt-2 space-y-1">{checklist.items.map((item) => <li key={item.id}><label className="flex min-h-10 cursor-pointer items-center gap-2 rounded border bg-background px-2 py-1.5"><input type="checkbox" checked={item.completed} onChange={() => void atualizarChecklist(item)} /><span className={cn(item.completed && "text-muted-foreground line-through")}>{item.label}{item.required ? " *" : ""}</span></label></li>)}</ul></>}
          {!checklistCarregando && processoSelecionado.tipoAcaoCodigo && !checklist.template && canManage && <div className="mt-2 space-y-2 rounded border bg-background p-2"><p className="text-muted-foreground">{t("Crie o modelo usado por todos os processos deste tipo de ação.")}</p><Input value={modeloNome} onChange={(event) => setModeloNome(event.target.value)} placeholder={t("Nome do checklist")} maxLength={120} /><Textarea value={modeloItens} onChange={(event) => setModeloItens(event.target.value)} placeholder={t("Um documento por linha")} maxLength={4000} /><Button type="button" size="sm" onClick={() => void criarModeloChecklist()}>{t("Criar modelo")}</Button></div>}
          {!checklistCarregando && processoSelecionado.tipoAcaoCodigo && !checklist.template && !canManage && <p className="mt-1 text-muted-foreground">{t("Nenhum checklist configurado para este tipo de ação.")}</p>}
          {checklistErro && <p role="alert" className="mt-1 text-error-fg">{checklistErro}</p>}
        </div>
        <form className="mt-3 space-y-2 border-t pt-3" onSubmit={criarAtividade}>
          <p className="font-semibold">{t("Criar atividade neste processo")}</p>
          <label className="block space-y-1"><span>{t("Título")}</span><Input value={tituloAtividade} maxLength={255} required disabled={atividadeSalvando || atividadeCriada !== null}
            onChange={(event) => { setTituloAtividade(event.target.value); chaveAtividade.current = null; }} placeholder={t("Ex.: Solicitar contrato assinado")} /></label>
          <label className="block space-y-1"><span>{t("Descrição (opcional)")}</span><Textarea value={descricaoAtividade} maxLength={5000} disabled={atividadeSalvando || atividadeCriada !== null}
            onChange={(event) => { setDescricaoAtividade(event.target.value); chaveAtividade.current = null; }} /></label>
          <label className="block space-y-1"><span>{t("Prazo (opcional)")}</span><Input type="date" value={dataAtividade} disabled={atividadeSalvando || atividadeCriada !== null}
            onChange={(event) => { setDataAtividade(event.target.value); chaveAtividade.current = null; }} /></label>
          {atividadeErro && <p role="alert" className="text-error-fg">{atividadeErro}</p>}
          {atividadeCriada !== null ? <p role="status" className="text-emerald-700">{t("Atividade criada no Advomax")}: #{atividadeCriada}</p>
            : <Button type="submit" size="sm" disabled={atividadeSalvando || !tituloAtividade.trim()}>{atividadeSalvando ? t("Criando…") : t("Criar atividade")}</Button>}
        </form>
      </div>}
      <div className="mt-4 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("Vínculos fixados no CRM")}</h3>
          <span className="text-xs text-muted-foreground">{t("A ficha jurídica continua no Advomax")}</span>
        </div>
        {canManage && <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input inputMode="numeric" value={novoProcessoCodigo} onChange={(e) => setNovoProcessoCodigo(e.target.value)} placeholder={t("Código do processo")} aria-label={t("Código do processo")} />
          <Button variant="outline" onClick={vincularProcesso} disabled={salvandoProcesso}>{salvandoProcesso ? t("Salvando…") : t("Adicionar vínculo")}</Button>
        </div>}
        {processoLinksIndisponiveis && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os vínculos fixados estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
        {processoLinksCarregando && <Skeleton className="mt-2 h-8 w-full" />}
        {!processoLinksCarregando && !processoLinksIndisponiveis && processoLinks.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("Nenhum processo fixado neste contato.")}</p>}
        {!processoLinksCarregando && !processoLinksIndisponiveis && processoLinks.length > 0 && <ul className="mt-2 space-y-1 text-sm">{processoLinks.map((processo) => <li key={processo.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
          <strong>#{processo.processo_codigo}</strong>
          <span className="flex items-center gap-2"><a className="text-primary underline-offset-2 hover:underline" href={processo.advomax_url || advomaxProcessUrl(processo.processo_codigo)} target="_blank" rel="noreferrer">{t("Abrir ficha")}</a>{canManage && <Button variant="ghost" size="sm" onClick={() => void desvincularProcesso(processo.processo_codigo)} disabled={salvandoProcesso}>{t("Remover")}</Button>}</span>
        </li>)}</ul>}
      </div>
      <h3 className="mt-4 text-sm font-semibold">{t("Documentos da Pessoa")}</h3>
      {documentosIndisponiveis && <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os documentos estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
      {documentosCarregando && <Skeleton className="mt-2 h-12 w-full" />}
      {!documentosCarregando && !documentosIndisponiveis && documentos.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t("Nenhum documento encontrado no Advomax.")}</p>}
      {!documentosCarregando && !documentosIndisponiveis && documentos.length > 0 && <ul className="mt-2 space-y-1 text-sm">{documentos.slice(0, 8).map((documento) => <li key={documento.codigo} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
        <span className="min-w-0"><strong className="block truncate">{documento.nomeArquivo}</strong><span className="text-xs text-muted-foreground">{documento.descricao || documento.data}{documento.origem === "whatsapp" ? ` · ${t("WhatsApp")}` : ""}</span></span>
        <Badge variant={documento.armazenadoNoDrive ? "success" : "secondary"}>{documento.armazenadoNoDrive ? t("No Drive") : t("No Advomax")}</Badge>
      </li>)}</ul>}
    </div>}
  </Card>;
}
