"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  cancelarContrato,
  enviarParaAssinatura,
  gerarContrato,
  gerarLinkDePagamento,
  marcarNoContrato,
  previaDoContrato,
  recusarContrato,
  salvarTextoDoContrato,
  type DadosDoContrato,
} from "@/app/actions/agencia/contratos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROTULO_DA_SITUACAO_DO_CONTRATO, type SituacaoVisivel } from "@/lib/agencia/contratos/regras";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";
import { formatCentsBRL } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * A aba Contratos da ficha do cliente (docs/agencia/SPEC-contratos.md).
 * O texto é preenchido no servidor; aqui só se escolhe, confere e age.
 */
export interface ContratoDaFicha {
  id: string;
  titulo: string;
  modeloNome: string;
  texto: string;
  situacao: SituacaoVisivel;
  valorMensalCents: number;
  validoAte: string;
  assinadoEm: string | null;
  pagoEm: string | null;
  concluidoEm: string | null;
  zapsignLink: string | null;
  zapsignSituacao: string | null;
  pagamentoLink: string | null;
  grupoCriado: boolean;
  podeEditarTexto: boolean;
}

function dataCurta(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `${d}/${m}/${a}`;
}

const COR: Partial<Record<SituacaoVisivel, string>> = {
  concluido: "border-emerald-500/50 bg-emerald-500/10",
  vencido: "border-amber-500/50 bg-amber-500/10",
  recusado: "border-destructive/40",
  cancelado: "opacity-60",
};

export function ContratosDoCliente(p: {
  clienteId: string;
  contratos: ContratoDaFicha[];
  modelos: Array<{ id: string; nome: string }>;
  contratacoes: Array<{ id: string; rotulo: string }>;
  hoje: string;
  integracoes: { zapsign: boolean; infinitepay: boolean };
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [novo, setNovo] = useState(p.contratos.length === 0);
  const [dados, setDados] = useState<DadosDoContrato>({
    clienteId: p.clienteId,
    modeloId: p.modelos[0]?.id ?? "",
    contratacaoId: p.contratacoes[0]?.id ?? null,
    valorMensal: "",
    formaPagamento: "PIX ou cartão pelo link de pagamento",
    diaVencimento: 10,
    prazoMeses: 3,
    fechamento: p.hoje,
    validadeDias: 5,
  });
  const [previa, setPrevia] = useState<{ texto: string; faltando: string[]; desconhecidos: string[] } | null>(null);
  const [datas, setDatas] = useState<Record<string, string>>({});
  const [editandoTexto, setEditandoTexto] = useState<{ id: string; texto: string } | null>(null);

  function agir<T>(acao: () => Promise<{ ok: true; dados?: T } | { ok: false; erro: string }>, sucesso: (d: T | undefined) => string) {
    setMsg(null);
    startTransition(async () => {
      const r = await acao();
      if (!r.ok) setMsg({ ok: false, texto: r.erro });
      else setMsg({ ok: true, texto: sucesso("dados" in r ? r.dados : undefined) });
      router.refresh();
    });
  }

  function verPrevia() {
    setMsg(null);
    startTransition(async () => {
      const r = await previaDoContrato(dados);
      if (!r.ok) return setMsg({ ok: false, texto: r.erro });
      setPrevia(r.dados);
    });
  }

  return (
    <section className="space-y-4" data-testid="contratos-do-cliente">
      {!p.integracoes.zapsign || !p.integracoes.infinitepay ? (
        <p className="text-xs text-muted-foreground">
          {!p.integracoes.zapsign && "Sem ZapSign configurada: marque a assinatura à mão. "}
          {!p.integracoes.infinitepay && "Sem InfinitePay configurada: marque o pagamento à mão. "}
          As duas se configuram em Configurações.
        </p>
      ) : null}

      {p.contratos.map((c) => (
        <article key={c.id} className={cn("space-y-3 rounded-md border p-4", COR[c.situacao])} data-testid="contrato">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">{c.titulo}</h3>
            <span className="text-sm font-medium" data-testid="situacao-do-contrato">
              {ROTULO_DA_SITUACAO_DO_CONTRATO[c.situacao]}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {formatCentsBRL(c.valorMensalCents)} por mês · {c.modeloNome} · proposta válida até {dataCurta(c.validoAte)}
            {c.assinadoEm && ` · assinado em ${formatarDataHora(c.assinadoEm)}`}
            {c.pagoEm && ` · pago em ${formatarDataHora(c.pagoEm)}`}
          </p>
          {c.situacao === "concluido" && (
            <p className="text-sm" data-testid="contrato-concluido">
              Assinado e pago em {c.concluidoEm ? formatarDataHora(c.concluidoEm) : "—"}.{" "}
              {c.grupoCriado ? "Grupo do WhatsApp criado." : "O grupo do WhatsApp não foi criado pela central — veja os avisos."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/api/v1/agencia/contratos/${c.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border px-3 text-sm">
              Abrir PDF
            </a>
            {c.podeEditarTexto && (
              <Button type="button" size="sm" variant="outline" onClick={() => setEditandoTexto({ id: c.id, texto: c.texto })}>
                Ajustar texto
              </Button>
            )}
            {c.zapsignLink && (
              <a href={c.zapsignLink} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">
                Link de assinatura{c.zapsignSituacao === "refused" ? " (recusado na ZapSign)" : ""}
              </a>
            )}
            {c.pagamentoLink && (
              <a href={c.pagamentoLink} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">
                Link de pagamento
              </a>
            )}
          </div>

          {!["concluido", "recusado", "cancelado"].includes(c.situacao) && (
            <div className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap gap-2">
                {p.integracoes.zapsign && !c.zapsignLink && (
                  <Button type="button" size="sm" disabled={pendente} onClick={() => agir(() => enviarParaAssinatura(c.id), () => "Enviado para assinatura na ZapSign.")}>
                    Enviar para assinatura (ZapSign)
                  </Button>
                )}
                {p.integracoes.infinitepay && !c.pagamentoLink && (
                  <Button type="button" size="sm" disabled={pendente} onClick={() => agir(() => gerarLinkDePagamento(c.id), () => "Link de pagamento gerado.")}>
                    Gerar link de pagamento (InfinitePay)
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  aria-label="Dia"
                  value={datas[c.id] ?? p.hoje}
                  max={p.hoje}
                  onChange={(e) => setDatas({ ...datas, [c.id]: e.target.value })}
                  className="h-8 w-40"
                />
                {!c.assinadoEm && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pendente}
                    onClick={() =>
                      agir(
                        () => marcarNoContrato(c.id, "assinado", datas[c.id] ?? p.hoje),
                        (d) => (d?.efeitos.concluiu ? resumo(d.efeitos) : "Assinatura registrada. Falta o pagamento."),
                      )
                    }
                  >
                    Marcar assinado
                  </Button>
                )}
                {!c.pagoEm && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pendente}
                    onClick={() =>
                      agir(
                        () => marcarNoContrato(c.id, "pago", datas[c.id] ?? p.hoje),
                        (d) => (d?.efeitos.concluiu ? resumo(d.efeitos) : "Pagamento registrado. Falta a assinatura."),
                      )
                    }
                  >
                    Marcar pago
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pendente}
                  onClick={() =>
                    window.confirm("O cliente recusou esta proposta?") &&
                    agir(
                      () => recusarContrato(c.id),
                      (d) => (d?.remarketing ? "Contrato recusado; cliente em remarketing." : "Proposta recusada; o cliente segue ativo com o contrato que já tem."),
                    )
                  }
                >
                  Recusou
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pendente}
                  onClick={() => window.confirm("Cancelar este contrato?") && agir(() => cancelarContrato(c.id), () => "Contrato cancelado.")}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          {editandoTexto?.id === c.id && (
            <div className="space-y-2">
              <textarea
                aria-label="Texto do contrato"
                rows={18}
                value={editandoTexto.texto}
                onChange={(e) => setEditandoTexto({ id: c.id, texto: e.target.value })}
                className="w-full rounded-md border bg-background p-2 font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={pendente}
                  onClick={() => {
                    agir(() => salvarTextoDoContrato(c.id, editandoTexto.texto), () => "Texto salvo.");
                    setEditandoTexto(null);
                  }}
                >
                  Salvar texto
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditandoTexto(null)}>
                  Fechar
                </Button>
              </div>
            </div>
          )}
        </article>
      ))}

      {!novo ? (
        <Button type="button" variant="outline" onClick={() => setNovo(true)}>
          Novo contrato
        </Button>
      ) : p.modelos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum modelo de contrato ativo. Crie um em Contratos › Modelos.</p>
      ) : (
        <div className="space-y-3 rounded-md border p-4" data-testid="novo-contrato">
          <h3 className="font-semibold">Novo contrato</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contrato-modelo">Modelo</Label>
              <select id="contrato-modelo" value={dados.modeloId} onChange={(e) => setDados({ ...dados, modeloId: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {p.modelos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nome}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="contrato-contratacao">Contratação</Label>
              <select
                id="contrato-contratacao"
                value={dados.contratacaoId ?? ""}
                onChange={(e) => setDados({ ...dados, contratacaoId: e.target.value || null })}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Nenhuma</option>
                {p.contratacoes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.rotulo}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="contrato-valor">Valor mensal (R$)</Label>
              <Input id="contrato-valor" inputMode="decimal" placeholder="2.500,00" value={dados.valorMensal} onChange={(e) => setDados({ ...dados, valorMensal: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contrato-forma">Forma de pagamento</Label>
              <Input id="contrato-forma" value={dados.formaPagamento} onChange={(e) => setDados({ ...dados, formaPagamento: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:col-span-2">
              <div className="space-y-1">
                <Label htmlFor="contrato-vencimento">Vencimento (dia)</Label>
                <Input
                  id="contrato-vencimento"
                  type="number"
                  min={1}
                  max={31}
                  value={dados.diaVencimento ?? ""}
                  onChange={(e) => setDados({ ...dados, diaVencimento: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="contrato-prazo">Prazo (meses)</Label>
                <Input id="contrato-prazo" type="number" min={1} max={120} value={dados.prazoMeses} onChange={(e) => setDados({ ...dados, prazoMeses: Number(e.target.value) || 3 })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="contrato-fechamento">Fechamento</Label>
                <Input id="contrato-fechamento" type="date" value={dados.fechamento} onChange={(e) => setDados({ ...dados, fechamento: e.target.value })} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={pendente || !dados.modeloId} onClick={verPrevia}>
              Ver prévia
            </Button>
            <Button
              type="button"
              disabled={pendente || !dados.modeloId}
              onClick={() =>
                agir(
                  () => gerarContrato(dados),
                  () => "Contrato gerado.",
                )
              }
            >
              Gerar contrato
            </Button>
          </div>
          {previa && (
            <div className="space-y-2" data-testid="previa-do-contrato">
              {previa.faltando.length > 0 && (
                <p className="text-sm text-amber-700 dark:text-amber-400">Falta no cadastro: {previa.faltando.join(", ")}. Dá para gerar e ajustar o texto depois.</p>
              )}
              {previa.desconhecidos.length > 0 && <p className="text-sm text-destructive">O modelo usa campos que não existem: {previa.desconhecidos.join(", ")}.</p>}
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">{previa.texto}</pre>
            </div>
          )}
        </div>
      )}

      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="mensagem-do-contrato">
          {msg.texto}
        </p>
      )}
    </section>
  );
}

function resumo(e: { trilha: boolean; formulario: string | null; grupo: string | null; pendencias: string[] }): string {
  const feito = [e.trilha && "trilha avançada", e.formulario === "enviado" && "formulário enviado ao cliente", e.grupo && "grupo criado"].filter(Boolean);
  return `Assinado e pago!${feito.length ? ` Feito: ${feito.join(", ")}.` : ""}${e.pendencias.length ? ` Falta fazer à mão: ${e.pendencias.join("; ")}.` : ""}`;
}
