"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BuscarEEscolher, mensagemDeErro, type Opcao } from "@/components/crm-b2b/BuscarEEscolher";
import { useT } from "@/hooks/i18n/useT";

interface Estado {
  person: { id: string; full_name: string; email: string | null } | null;
  companies: Array<{
    id: string;
    job_title: string | null;
    is_decision_maker: boolean;
    companies: { id: string; trade_name: string | null; legal_name: string | null } | null;
  }>;
}

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

/**
 * De quem é este telefone (issue #3198). Só existe com o módulo "Empresas e
 * pessoas" ligado: a página decide no servidor e, desligado, este cartão não
 * é montado — nenhum botão, nenhum campo, nenhuma chamada.
 *
 * `podeEditar` segue o piso do PATCH contacts/:id/person (`agent`);
 * `podeCriarPessoa`, o do POST /api/v1/people (`agent`, migration 9348).
 */
export function PessoaDoContato({
  contactId,
  podeEditar,
  podeCriarPessoa = false,
  nomeSugerido = "",
}: {
  contactId: string;
  podeEditar: boolean;
  podeCriarPessoa?: boolean;
  /** O nome do contato, já na busca: o caminho comum é achar ou criar com ele. */
  nomeSugerido?: string;
}) {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/contacts/${contactId}/person`);
    const json = await res.json().catch(() => null);
    if (res.ok) setEstado(json.data as Estado);
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function ligar(personId: string | null) {
    const res = await fetch(`/api/v1/contacts/${contactId}/person`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: personId }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (!falha) void load();
    return falha;
  }

  /**
   * O lead do WhatsApp ainda não tem pessoa: cria com o nome digitado e liga
   * este telefone a ela. Se a ligação falhar, a pessoa fica criada sem
   * telefone e a mensagem diz o motivo.
   */
  async function criarPessoa(nome: string) {
    const res = await fetch("/api/v1/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: nome }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    if (falha) return falha;
    const json = await res.json().catch(() => null);
    const novoId = json?.data?.id as string | undefined;
    if (!novoId) return t("Não foi possível salvar.");
    return ligar(novoId);
  }

  async function desligar() {
    setErro(null);
    const falha = await ligar(null);
    if (falha) setErro(falha);
  }

  if (!estado) return null;

  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{t("Pessoa")}</h2>
        {podeEditar ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setAberto(true)}>
              {estado.person ? t("Trocar") : t("Ligar a uma pessoa")}
            </Button>
            {estado.person ? (
              <Button size="sm" variant="ghost" onClick={() => void desligar()}>
                {t("Desvincular")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {estado.person ? (
        <div className="space-y-1 text-sm">
          <Link href={`/app/people/${estado.person.id}`} className="font-medium hover:underline">
            {estado.person.full_name}
          </Link>
          {estado.companies.length > 0 ? (
            <ul className="space-y-1 text-muted-foreground">
              {estado.companies.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2">
                  {l.companies ? (
                    <Link href={`/app/companies/${l.companies.id}`} className="hover:underline">
                      {l.companies.trade_name || l.companies.legal_name || l.companies.id}
                    </Link>
                  ) : null}
                  {l.job_title ? <span>· {l.job_title}</span> : null}
                  {l.is_decision_maker ? <Badge variant="secondary">{t("Decisor")}</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t("Sem vínculo empresarial.")}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Este telefone ainda não está ligado a uma pessoa.")}
        </p>
      )}
      {erro ? (
        <p className="text-sm text-destructive" role="alert">
          {erro}
        </p>
      ) : null}

      <BuscarEEscolher
        aberto={aberto}
        onAbertoChange={setAberto}
        titulo={t("Ligar a uma pessoa")}
        endpoint="/api/v1/people"
        mapear={opcaoDePessoa}
        ocultar={estado.person ? [estado.person.id] : []}
        placeholder={t("Buscar pessoa por nome ou e-mail")}
        buscaInicial={estado.person ? "" : nomeSugerido}
        rotuloConfirmar={t("Vincular")}
        onConfirmar={(p) => ligar(p.id)}
        criarNovo={
          podeCriarPessoa ? { rotulo: t("Criar nova pessoa"), acao: criarPessoa } : undefined
        }
      />
    </Card>
  );
}
