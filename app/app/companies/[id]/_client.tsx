"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BuscarEEscolher, mensagemDeErro, type Opcao } from "@/components/crm-b2b/BuscarEEscolher";
import { CamposDoVinculo, VINCULO_VAZIO, type Vinculo } from "@/components/crm-b2b/CamposDoVinculo";
import { AdicionarPessoaComContato } from "@/components/crm-b2b/AdicionarPessoaComContato";
import { EditarVinculo, type VinculoEmEdicao } from "@/components/crm-b2b/EditarVinculo";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";

interface Props {
  id: string;
}

/**
 * Campos editáveis da empresa (issue #1937). O backend já aceitava PATCH desde
 * o início — o que faltava era uma ação na tela. CNPJ entra aqui porque a
 * correção de edição também cobre o formato: o handler normaliza e devolve
 * com máscara.
 */
const CAMPOS = [
  "legal_name",
  "trade_name",
  "cnpj",
  "email",
  "phone",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "zip_code",
] as const;

type Campo = (typeof CAMPOS)[number];
type Formulario = Record<Campo, string>;

function opcaoDePessoa(linha: Record<string, unknown>): Opcao {
  return {
    id: linha.id as string,
    titulo: linha.full_name as string,
    detalhe:
      (Array.isArray(linha.emails) ? (linha.emails as string[]).join(" · ") : null) ||
      (linha.email as string) ||
      null,
  };
}

function formularioVazio(): Formulario {
  return Object.fromEntries(CAMPOS.map((c) => [c, ""])) as Formulario;
}

function formularioDaEmpresa(empresa: Record<string, unknown>): Formulario {
  const f = formularioVazio();
  for (const campo of CAMPOS) {
    const valor = empresa[campo];
    f[campo] = typeof valor === "string" ? valor : "";
  }
  return f;
}

export function CompanyDetailClient({ id }: Props) {
  const t = useT();
  const router = useRouter();
  const { user, activeOrg } = useAuth();
  const [data, setData] = useState<{
    company: Record<string, unknown>;
    people: Array<Record<string, unknown>>;
    contacts: Array<Record<string, unknown>>;
  } | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<Formulario>(formularioVazio);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pessoaAberto, setPessoaAberto] = useState(false);
  const [contatoAberto, setContatoAberto] = useState(false);
  const [vinculo, setVinculo] = useState<Vinculo>(VINCULO_VAZIO);
  const [erroDasPessoas, setErroDasPessoas] = useState<string | null>(null);
  const [emEdicao, setEmEdicao] = useState<VinculoEmEdicao | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/companies/${id}`);
    const json = await res.json();
    if (res.ok) setData(json.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function enrich() {
    setEnriching(true);
    await fetch(`/api/v1/companies/${id}/enrich`, { method: "POST" });
    setEnriching(false);
    void load();
  }

  function abrirEdicao() {
    if (!data) return;
    setForm(formularioDaEmpresa(data.company));
    setEditError(null);
    setEditOpen(true);
  }

  async function salvar() {
    setSaving(true);
    setEditError(null);
    // `""` não passa pelo schema (`min(1)`): o valor vazio vira null, que o
    // handler grava como coluna nula.
    const body: Record<string, unknown> = {};
    for (const campo of CAMPOS) body[campo] = form[campo] === "" ? null : form[campo];
    const res = await fetch(`/api/v1/companies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok) {
      const dica = json?.error?.details?.dica;
      setEditError([json?.error?.message, dica].filter(Boolean).join(" ") || t("Não foi possível salvar."));
      return;
    }
    setEditOpen(false);
    void load();
  }

  async function excluir() {
    setDeleting(true);
    setDeleteError(null);
    const res = await fetch(`/api/v1/companies/${id}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    setDeleting(false);
    if (!res.ok) {
      // O motivo vem do servidor: 409 é vínculo que impede a exclusão, 403 é
      // papel insuficiente. A tela não inventa frase para isso.
      setDeleteError(json?.error?.message || t("Não foi possível excluir."));
      return;
    }
    setDeleteOpen(false);
    router.push("/app/companies");
  }

  // Mesmos degraus de app/app/contacts/[id]: `agent` para editar, `manager`
  // para excluir — o mesmo piso de requireRole() nas rotas.
  const podeEditar =
    Boolean(user.is_platform_admin && !user.support) ||
    Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent);
  const podeExcluir =
    Boolean(user.is_platform_admin && !user.support) ||
    Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  // Corrigir cargo/decisor é o PATCH company-people/:id, piso `agent`.
  const podeEditarVinculo =
    Boolean(user.is_platform_admin && !user.support) ||
    Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent);

  async function ligarPessoa(pessoa: Opcao) {
    const res = await fetch("/api/v1/company-people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: id,
        person_id: pessoa.id,
        job_title: vinculo.job_title.trim() || null,
        is_decision_maker: vinculo.is_decision_maker,
      }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (!falha) {
      setVinculo(VINCULO_VAZIO);
      void load();
    }
    return falha;
  }

  /** Cadastra a pessoa já ligada a esta empresa: o POST de pessoas aceita `company_id`. */
  async function criarPessoa(nome: string) {
    const res = await fetch("/api/v1/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: nome,
        company_id: id,
        job_title: vinculo.job_title.trim() || null,
        is_decision_maker: vinculo.is_decision_maker,
      }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (!falha) {
      setVinculo(VINCULO_VAZIO);
      void load();
    }
    return falha;
  }

  async function desligarPessoa(vinculoId: string) {
    setErroDasPessoas(null);
    const res = await fetch(`/api/v1/company-people/${vinculoId}`, { method: "DELETE" });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (falha) setErroDasPessoas(falha);
    void load();
  }

  if (!data) {
    return <div className="p-6 text-muted-foreground">{t("Carregando…")}</div>;
  }

  const c = data.company;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/app/companies" className="text-sm text-muted-foreground hover:underline">
            ← {t("Empresas")}
          </Link>
          <h1 className="text-xl font-semibold">
            {(c.trade_name as string) || (c.legal_name as string) || t("Empresa")}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">{(c.cnpj as string) || "—"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void enrich()} disabled={enriching}>
            {enriching ? t("Enriquecendo…") : t("Enriquecer CNPJ")}
          </Button>
          {podeEditar ? (
            <Button variant="outline" onClick={abrirEdicao}>
              {t("Editar empresa")}
            </Button>
          ) : null}
          {podeExcluir ? (
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              {t("Excluir empresa")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4">
          <h2 className="font-medium">{t("Dados cadastrais")}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("Razão social")}</dt>
            <dd>{(c.legal_name as string) || "—"}</dd>
            <dt className="text-muted-foreground">{t("Situação")}</dt>
            <dd>{(c.registration_status as string) || "—"}</dd>
            <dt className="text-muted-foreground">{t("Porte")}</dt>
            <dd>{(c.company_size as string) || "—"}</dd>
            <dt className="text-muted-foreground">CNAE</dt>
            <dd>
              {[c.main_cnae_code, c.main_cnae_description].filter(Boolean).join(" — ") || "—"}
            </dd>
            <dt className="text-muted-foreground">{t("Endereço")}</dt>
            <dd>
              {[c.street, c.number, c.district, c.city, c.state, c.zip_code]
                .filter(Boolean)
                .join(", ") || "—"}
            </dd>
            <dt className="text-muted-foreground">{t("Enriquecimento")}</dt>
            <dd>
              {(c.enrichment_status as string) || "—"}
              {c.enrichment_error ? ` — ${c.enrichment_error}` : ""}
            </dd>
          </dl>
        </Card>

        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("Pessoas / decisores")}</h2>
            {/* Piso `agent` para ADICIONAR (migration 9348); remover o vínculo segue `manager`. */}
            {podeEditarVinculo ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setContatoAberto(true)}>
                  {t("Adicionar pessoa com contato")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPessoaAberto(true)}>
                  {t("Adicionar pessoa")}
                </Button>
              </div>
            ) : null}
          </div>
          {erroDasPessoas ? (
            <p className="text-sm text-destructive" role="alert">
              {erroDasPessoas}
            </p>
          ) : null}
          {data.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma pessoa vinculada.")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.people.map((p) => {
                const person = p.people as { id: string; full_name: string; email?: string } | null;
                return (
                  <li key={p.id as string} className="flex justify-between gap-2 border-b pb-2">
                    {person ? (
                      <div>
                        <Link
                          className="font-medium hover:underline"
                          href={`/app/people/${person.id}`}
                        >
                          {person.full_name}
                        </Link>
                      </div>
                    ) : (
                      "—"
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2 text-muted-foreground">
                      {(p.job_title as string) || ""}
                      {p.is_decision_maker ? (
                        <Badge variant="secondary">{t("Decisor")}</Badge>
                      ) : null}
                      {podeEditarVinculo ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t("Editar vínculo")}: ${person?.full_name ?? ""}`}
                          onClick={() =>
                            setEmEdicao({
                              id: p.id as string,
                              nome: person?.full_name ?? "",
                              job_title: (p.job_title as string | null) ?? null,
                              is_decision_maker: Boolean(p.is_decision_maker),
                            })
                          }
                        >
                          {t("Editar")}
                        </Button>
                      ) : null}
                      {podeExcluir ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void desligarPessoa(p.id as string)}
                        >
                          {t("Remover")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Telefones e e-mails AGRUPADOS por pessoa: antes era uma lista solta,
            e não dava para saber de quem era cada número (issue #3198). */}
        <Card className="space-y-2 p-4 md:col-span-2">
          <h2 className="font-medium">{t("Telefones e e-mails")}</h2>
          {data.people.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nenhum telefone ligado às pessoas desta empresa.")}
            </p>
          ) : (
            <ul className="grid gap-3 text-sm sm:grid-cols-2">
              {data.people.map((p) => {
                const person = p.people as { id: string; full_name: string; email?: string } | null;
                if (!person) return null;
                const dela = data.contacts.filter((ct) => ct.person_id === person.id);
                const emailDaFicha =
                  person.email &&
                  !dela.some(
                    (ct) => String(ct.email ?? "").toLowerCase() === person.email!.toLowerCase(),
                  )
                    ? person.email
                    : null;
                return (
                  <li
                    key={p.id as string}
                    className="space-y-1 rounded-md border px-3 py-2"
                    aria-label={`${t("Telefones e e-mails")}: ${person.full_name}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link href={`/app/people/${person.id}`} className="font-medium hover:underline">
                        {person.full_name}
                      </Link>
                      {p.job_title ? (
                        <span className="text-xs text-muted-foreground">{p.job_title as string}</span>
                      ) : null}
                    </div>
                    {dela.length === 0 && !emailDaFicha ? (
                      <p className="text-muted-foreground">{t("Sem telefone nem e-mail.")}</p>
                    ) : (
                      <ul className="space-y-1">
                        {dela.map((ct) => (
                          <li key={ct.id as string}>
                            <Link href={`/app/contacts/${ct.id}`} className="font-mono hover:underline">
                              {(ct.phone_number as string) || (ct.email as string) || "—"}
                            </Link>
                            {ct.phone_number && ct.email ? (
                              <Link
                                href={`/app/contacts/${ct.id}`}
                                className="ml-2 text-muted-foreground hover:underline"
                              >
                                {ct.email as string}
                              </Link>
                            ) : null}
                          </li>
                        ))}
                        {emailDaFicha ? (
                          // Ainda não é contato: leva à ficha da pessoa, onde
                          // "Juntar ao contato" o passa para o telefone dela.
                          <li>
                            <Link
                              href={`/app/people/${person.id}`}
                              className="font-mono hover:underline"
                            >
                              {emailDaFicha}
                            </Link>
                            <span className="ml-2 text-xs text-muted-foreground">
                              {t("da ficha da pessoa")}
                            </span>
                          </li>
                        ) : null}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <BuscarEEscolher
        aberto={pessoaAberto}
        onAbertoChange={(a) => {
          setPessoaAberto(a);
          if (!a) setVinculo(VINCULO_VAZIO);
        }}
        titulo={t("Adicionar pessoa")}
        endpoint="/api/v1/people"
        mapear={opcaoDePessoa}
        ocultar={data.people
          .map((p) => (p.people as { id: string } | null)?.id)
          .filter((x): x is string => Boolean(x))}
        placeholder={t("Buscar pessoa por nome ou e-mail")}
        rotuloConfirmar={t("Adicionar")}
        onConfirmar={ligarPessoa}
        criarNovo={{ rotulo: t("Criar nova pessoa"), acao: criarPessoa }}
      >
        <CamposDoVinculo valor={vinculo} onChange={setVinculo} />
      </BuscarEEscolher>

      <AdicionarPessoaComContato
        empresaId={id}
        aberto={contatoAberto}
        onAbertoChange={setContatoAberto}
        onSalvo={() => void load()}
      />

      <EditarVinculo
        key={emEdicao ? `vinculo|${emEdicao.id}` : "vinculo-fechado"}
        vinculo={emEdicao}
        onFechar={() => setEmEdicao(null)}
        onSalvo={() => void load()}
      />

      <Dialog
        open={editOpen}
        onOpenChange={(aberto) => {
          setEditOpen(aberto);
          if (!aberto) setEditError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Editar empresa")}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1">
            <div className="grid gap-1.5">
              <Label>{t("Razão social")}</Label>
              <Input
                value={form.legal_name}
                maxLength={500}
                onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Nome fantasia")}</Label>
              <Input
                value={form.trade_name}
                maxLength={500}
                onChange={(e) => setForm({ ...form, trade_name: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>CNPJ</Label>
              <Input
                value={form.cnpj}
                placeholder="00.000.000/0000-00"
                maxLength={32}
                onChange={(e) => setForm({ ...form, cnpj: e.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>{t("E-mail")}</Label>
                <Input
                  type="email"
                  value={form.email}
                  maxLength={254}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Telefone")}</Label>
                <Input
                  value={form.phone}
                  maxLength={40}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <div className="grid gap-1.5">
                <Label>{t("Rua")}</Label>
                <Input
                  value={form.street}
                  maxLength={300}
                  onChange={(e) => setForm({ ...form, street: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Número")}</Label>
                <Input
                  value={form.number}
                  maxLength={40}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>{t("Complemento")}</Label>
                <Input
                  value={form.complement}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, complement: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Bairro")}</Label>
                <Input
                  value={form.district}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, district: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_5rem_9rem]">
              <div className="grid gap-1.5">
                <Label>{t("Cidade")}</Label>
                <Input
                  value={form.city}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>UF</Label>
                <Input
                  value={form.state}
                  maxLength={2}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>CEP</Label>
                <Input
                  value={form.zip_code}
                  maxLength={16}
                  onChange={(e) => setForm({ ...form, zip_code: e.target.value })}
                />
              </div>
            </div>
            {editError ? (
              <p className="text-sm text-destructive" role="alert">
                {editError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void salvar()} disabled={saving}>
              {saving ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(aberto) => {
          setDeleteOpen(aberto);
          if (!aberto) setDeleteError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Excluir empresa")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <p>
              {t(
                "A exclusão apaga o cadastro da empresa. Se houver pessoas vinculadas, a exclusão é recusada e a tela mostra o motivo; nada é apagado.",
              )}
            </p>
            <p className="font-medium">
              {(c.legal_name as string) || (c.trade_name as string) || t("Empresa")}
              {c.cnpj ? ` — ${c.cnpj as string}` : ""}
            </p>
            {deleteError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive" role="alert">
                {deleteError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t("Cancelar")}
            </Button>
            <Button variant="destructive" onClick={() => void excluir()} disabled={deleting}>
              {deleting ? t("Excluindo…") : t("Excluir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
