"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BuscarEEscolher, mensagemDeErro, type Opcao } from "@/components/crm-b2b/BuscarEEscolher";
import { CamposDoVinculo, VINCULO_VAZIO, type Vinculo } from "@/components/crm-b2b/CamposDoVinculo";
import { EditarVinculo, type VinculoEmEdicao } from "@/components/crm-b2b/EditarVinculo";
import { NovoContato, type ContatoInicial } from "@/components/crm-b2b/NovoContato";
import { JuntarEmailAoContato } from "@/components/crm-b2b/JuntarEmailAoContato";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ROLE_RANK } from "@/lib/auth/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { telefoneOuEmail } from "@/components/crm-b2b/telefone-ou-email";

function opcaoDeEmpresa(linha: Record<string, unknown>): Opcao {
  return {
    id: linha.id as string,
    titulo: (linha.trade_name as string) || (linha.legal_name as string) || (linha.id as string),
    detalhe: (linha.cnpj as string) || null,
  };
}

function opcaoDeContato(linha: Record<string, unknown>): Opcao {
  const telefone = linha.phone_number as string | null;
  const email = linha.email as string | null;
  return {
    id: linha.id as string,
    titulo:
      (linha.display_name as string) ||
      (linha.name as string) ||
      (telefone ? phoneForDisplay(telefone) : email || "—"),
    detalhe: [telefone ? phoneForDisplay(telefone) : null, email].filter(Boolean).join(" · ") || null,
  };
}

export function PersonDetailClient({ id }: { id: string }) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [data, setData] = useState<{
    person: Record<string, unknown>;
    companies: Array<Record<string, unknown>>;
    contacts: Array<Record<string, unknown>>;
  } | null>(null);
  const [empresaAberto, setEmpresaAberto] = useState(false);
  const [contatoAberto, setContatoAberto] = useState(false);
  const [vinculo, setVinculo] = useState<Vinculo>(VINCULO_VAZIO);
  const [erroDaLista, setErroDaLista] = useState<string | null>(null);
  const [emEdicao, setEmEdicao] = useState<VinculoEmEdicao | null>(null);
  const [novoContato, setNovoContato] = useState<ContatoInicial | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/people/${id}`);
    const json = await res.json();
    if (res.ok) setData(json.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Mesmos pisos das rotas (issue #3198): ligar telefone é `agent`
  // (PATCH contacts/:id/person); ligar empresa é `agent` (POST company-people, migration 9348);
  // desligar segue `manager` (DELETE company-people e a RLS de company_people).
  const souAdminDaPlataforma = Boolean(user.is_platform_admin && !user.support);
  const podeLigarContato =
    souAdminDaPlataforma || Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent);
  const podeLigarEmpresa =
    souAdminDaPlataforma || Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent);
  const podeDesligarEmpresa =
    souAdminDaPlataforma || Boolean(activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);

  async function ligarEmpresa(empresa: Opcao) {
    const res = await fetch("/api/v1/company-people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: empresa.id,
        person_id: id,
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

  async function desligarEmpresa(vinculoId: string) {
    setErroDaLista(null);
    const res = await fetch(`/api/v1/company-people/${vinculoId}`, { method: "DELETE" });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (falha) setErroDaLista(falha);
    void load();
  }

  async function ligarContato(contato: Opcao) {
    const res = await fetch(`/api/v1/contacts/${contato.id}/person`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: id }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (!falha) void load();
    return falha;
  }

  /**
   * Telefone ou e-mail que ainda não existe: abre "Novo contato" com o que foi
   * digitado e o e-mail da pessoa (quando nenhum contato dela o usa), para o
   * contato nascer com os dois de uma vez.
   */
  function abrirNovoContato(texto: string) {
    const dado = telefoneOuEmail(texto);
    const emailLivre =
      data?.person.email &&
      !data.contacts.some(
        (c) => String(c.email ?? "").toLowerCase() === String(data.person.email).toLowerCase(),
      )
        ? String(data.person.email)
        : "";
    setNovoContato({
      telefone: dado && "phone_number" in dado ? texto.trim() : "",
      email: dado && "email" in dado ? dado.email : emailLivre,
    });
    return Promise.resolve(null);
  }

  async function desligarContato(contatoId: string) {
    setErroDaLista(null);
    const res = await fetch(`/api/v1/contacts/${contatoId}/person`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: null }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (falha) setErroDaLista(falha);
    void load();
  }

  if (!data) return <div className="p-6 text-muted-foreground">{t("Carregando…")}</div>;

  // O e-mail da ficha da pessoa, quando nenhum contato dela o tem: aparece no
  // mesmo cartão dos telefones e e-mails, sem link (não é um contato).
  const emailDaFicha =
    typeof data.person.email === "string" &&
    data.person.email &&
    !data.contacts.some(
      (c) => String(c.email ?? "").toLowerCase() === String(data.person.email).toLowerCase(),
    )
      ? (data.person.email as string)
      : null;

  const empresasLigadas = data.companies
    .map((l) => (l.companies as { id: string } | null)?.id)
    .filter((x): x is string => Boolean(x));

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <Link href="/app/people" className="text-sm text-muted-foreground hover:underline">
          ← {t("Pessoas")}
        </Link>
        <h1 className="text-xl font-semibold">{(data.person.full_name as string)}</h1>
      </div>

      {erroDaLista ? (
        <p className="text-sm text-destructive" role="alert">
          {erroDaLista}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("Empresas")}</h2>
            {podeLigarEmpresa ? (
              <Button size="sm" variant="outline" onClick={() => setEmpresaAberto(true)}>
                {t("Adicionar a uma empresa")}
              </Button>
            ) : null}
          </div>
          {data.companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Sem vínculo empresarial.")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.companies.map((l) => {
                const co = l.companies as {
                  id: string;
                  trade_name?: string;
                  legal_name?: string;
                } | null;
                return (
                  <li
                    key={l.id as string}
                    className="flex items-start justify-between gap-2 border-b pb-2"
                  >
                    <div>
                      {co ? (
                        <Link href={`/app/companies/${co.id}`} className="font-medium hover:underline">
                          {co.trade_name || co.legal_name || co.id}
                        </Link>
                      ) : (
                        "—"
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        {(l.job_title as string) || ""}
                        {l.is_decision_maker ? (
                          <Badge variant="secondary">{t("Decisor")}</Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {podeLigarContato ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${t("Editar vínculo")}: ${co?.trade_name || co?.legal_name || ""}`}
                          onClick={() =>
                            setEmEdicao({
                              id: l.id as string,
                              nome: co?.trade_name || co?.legal_name || "",
                              job_title: (l.job_title as string | null) ?? null,
                              is_decision_maker: Boolean(l.is_decision_maker),
                            })
                          }
                        >
                          {t("Editar")}
                        </Button>
                      ) : null}
                      {podeDesligarEmpresa ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void desligarEmpresa(l.id as string)}
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

        <Card className="space-y-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{t("Telefones e e-mails")}</h2>
            {podeLigarContato ? (
              <Button size="sm" variant="outline" onClick={() => setContatoAberto(true)}>
                {t("Vincular contato")}
              </Button>
            ) : null}
          </div>
          {data.contacts.length === 0 && !emailDaFicha ? (
            <p className="text-sm text-muted-foreground">{t("Nenhum contato vinculado.")}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {emailDaFicha ? (
                <li className="flex items-center justify-between gap-2 border-b pb-2">
                  <div>
                    <span className="font-mono">{emailDaFicha}</span>
                    <div className="text-xs text-muted-foreground">{t("da ficha da pessoa")}</div>
                  </div>
                  {podeLigarContato ? (
                    <JuntarEmailAoContato
                      email={emailDaFicha}
                      candidatos={data.contacts
                        .filter((ct) => !ct.email && ct.phone_number)
                        .map((ct) => ({
                          id: ct.id as string,
                          rotulo: phoneForDisplay(ct.phone_number as string),
                        }))}
                      onFeito={() => void load()}
                      onErro={setErroDaLista}
                      onCriarContato={() => setNovoContato({ telefone: "", email: emailDaFicha })}
                    />
                  ) : null}
                </li>
              ) : null}
              {data.contacts.map((ct) => (
                <li
                  key={ct.id as string}
                  className="flex items-center justify-between gap-2 border-b pb-2 last:border-0"
                >
                  <div>
                    <Link href={`/app/contacts/${ct.id}`} className="font-mono hover:underline">
                      {(ct.phone_number as string) || (ct.email as string) || "—"}
                    </Link>
                    {ct.phone_number && ct.email ? (
                      <Link
                        href={`/app/contacts/${ct.id}`}
                        className="block text-xs text-muted-foreground hover:underline"
                      >
                        {ct.email as string}
                      </Link>
                    ) : null}
                  </div>
                  {podeLigarContato ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void desligarContato(ct.id as string)}
                    >
                      {t("Desvincular")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <BuscarEEscolher
        aberto={empresaAberto}
        onAbertoChange={(a) => {
          setEmpresaAberto(a);
          if (!a) setVinculo(VINCULO_VAZIO);
        }}
        titulo={t("Adicionar a uma empresa")}
        endpoint="/api/v1/companies"
        mapear={opcaoDeEmpresa}
        ocultar={empresasLigadas}
        placeholder={t("Buscar empresa por nome ou CNPJ")}
        rotuloConfirmar={t("Adicionar")}
        onConfirmar={ligarEmpresa}
      >
        <CamposDoVinculo valor={vinculo} onChange={setVinculo} />
      </BuscarEEscolher>

      <BuscarEEscolher
        aberto={contatoAberto}
        onAbertoChange={setContatoAberto}
        titulo={t("Vincular contato")}
        endpoint="/api/v1/contacts"
        mapear={opcaoDeContato}
        ocultar={data.contacts.map((c) => c.id as string)}
        placeholder={t("Buscar contato por nome ou telefone")}
        rotuloConfirmar={t("Vincular")}
        onConfirmar={ligarContato}
        criarNovo={{
          rotulo: t("Criar contato"),
          acao: abrirNovoContato,
          aceita: (texto) => telefoneOuEmail(texto) !== null,
        }}
      />

      <NovoContato
        key={novoContato ? `novo|${novoContato.telefone}|${novoContato.email}` : "novo-fechado"}
        inicial={novoContato}
        personId={id}
        nome={data.person.full_name as string}
        onFechar={() => setNovoContato(null)}
        onCriado={() => void load()}
      />

      <EditarVinculo
        key={emEdicao ? `vinculo|${emEdicao.id}` : "vinculo-fechado"}
        vinculo={emEdicao}
        onFechar={() => setEmEdicao(null)}
        onSalvo={() => void load()}
      />
    </div>
  );
}
