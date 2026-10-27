import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ComponentProps } from "react";

import { FichaDoCliente } from "@/components/agencia/clientes/FichaDoCliente";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { apoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import { carregarQuemOlhaAgenda, listarReunioes } from "@/lib/agencia/calendario/consultas";
import { trilhaDoCliente } from "@/lib/agencia/trilhas/consultas";
import type { AprovacaoDaFicha } from "@/components/agencia/aprovacoes/AprovacoesDoCliente";
import { listarCofre } from "@/lib/agencia/cofre/cofre";
import { configDosContratos } from "@/lib/agencia/contratos/integracoes";
import { situacaoVisivel } from "@/lib/agencia/contratos/regras";
import { diaLocal } from "@/lib/agencia/tarefas/regras";
import { situacaoDoLink } from "@/lib/agencia/formulario/link";
import { respostasSchema } from "@/lib/agencia/formulario/perguntas";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { lerQuantidades, type SituacaoDoCliente } from "@/lib/agencia/clientes/vocabulario";
import { idSchema } from "@/lib/agencia/schemas";
import { apoioDoQuadro, carregarQuemOlha, listarTarefas } from "@/lib/agencia/tarefas/consultas";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Cliente · Agência" };
export const dynamic = "force-dynamic";

/** A ficha do cliente (docs/agencia/SPEC-clientes.md › Telas). */
export default async function PaginaDoCliente({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  // Quem não atende o cliente recebe 404, como se ele não existisse (critério 5).
  if (!podeVerCliente(alcance, id)) notFound();

  const db = createAdminClient();
  const { data } = await db.from("agencia_clientes").select("*").eq("id", id).maybeSingle();
  const c = data as Record<string, unknown> | null;
  if (!c) notFound();

  const quem = await carregarQuemOlha(ctx);
  const quemAgenda = await carregarQuemOlhaAgenda(ctx);
  const [empresas, contratacoes, equipe, membros, arquivos, orgs, drive, tarefas, apoio, reunioes, apoioAgenda, trilha, formulario, cofre, aprovacoes] = await Promise.all([
    db.from("agencia_clientes_empresas").select("nome, documento").eq("cliente_id", id).order("ordem"),
    db.from("agencia_contratacoes").select("*").eq("cliente_id", id).order("criado_em", { ascending: false }),
    db.from("agencia_clientes_membros").select("membro_id").eq("cliente_id", id),
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo").order("nome"),
    db.from("agencia_arquivos").select("id, nome, link, subpasta, criado_em").eq("cliente_id", id).order("criado_em", { ascending: false }).limit(50),
    ctx.permissoes.has("clientes.gerenciar")
      ? db.from("organizations").select("id, display_name").order("display_name")
      : Promise.resolve({ data: [] }),
    estadoDoDrive(),
    listarTarefas(quem, { clienteId: id }),
    apoioDoQuadro(quem),
    listarReunioes(quemAgenda, { clienteId: id }),
    apoioDaAgenda(quemAgenda),
    trilhaDoCliente(id),
    db
      .from("agencia_formularios")
      .select("id, situacao, expira_em, criado_em, enviado_em, respostas")
      .eq("cliente_id", id)
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle(),
    listarCofre(id),
    db
      .from("agencia_aprovacoes")
      .select("id, tipo, titulo, link, versao, situacao, comentario, pedido_em, respondido_em, tarefa_id")
      .eq("cliente_id", id)
      .order("pedido_em", { ascending: false })
      .limit(100),
  ]);
  const f = formulario.data as {
    id: string;
    situacao: string;
    expira_em: string;
    criado_em: string;
    enviado_em: string | null;
    respostas: unknown;
  } | null;
  const respostas = f?.respostas ? respostasSchema.safeParse(f.respostas) : null;

  // Contratos (docs/agencia/SPEC-contratos.md): só para quem tem `contratos.gerenciar`.
  let contratos: ComponentProps<typeof FichaDoCliente>["contratos"] = null;
  if (ctx.permissoes.has("contratos.gerenciar")) {
    const hoje = diaLocal(new Date());
    const [lista, modelosDeContrato, integracoes] = await Promise.all([
      db
        .from("agencia_contratos")
        .select("id, titulo, modelo_nome, texto, situacao, valor_mensal_cents, valido_ate, assinado_em, pago_em, concluido_em, zapsign_link, zapsign_situacao, pagamento_link, grupo_chat_id")
        .eq("cliente_id", id)
        .order("criado_em", { ascending: false }),
      db.from("agencia_contrato_modelos").select("id, nome").eq("ativo", true).order("nome"),
      configDosContratos(),
    ]);
    contratos = {
      hoje,
      modelos: (modelosDeContrato.data ?? []) as Array<{ id: string; nome: string }>,
      integracoes: { zapsign: !!integracoes.zapsignToken, infinitepay: !!integracoes.infinitepayHandle },
      lista: ((lista.data ?? []) as Array<{
        id: string;
        titulo: string;
        modelo_nome: string;
        texto: string;
        situacao: string;
        valor_mensal_cents: number;
        valido_ate: string;
        assinado_em: string | null;
        pago_em: string | null;
        concluido_em: string | null;
        zapsign_link: string | null;
        zapsign_situacao: string | null;
        pagamento_link: string | null;
        grupo_chat_id: string | null;
      }>).map((k) => ({
        id: k.id,
        titulo: k.titulo,
        modeloNome: k.modelo_nome,
        texto: k.texto,
        situacao: situacaoVisivel(k, hoje),
        valorMensalCents: Number(k.valor_mensal_cents),
        validoAte: k.valido_ate,
        assinadoEm: k.assinado_em,
        pagoEm: k.pago_em,
        concluidoEm: k.concluido_em,
        zapsignLink: k.zapsign_link,
        zapsignSituacao: k.zapsign_situacao,
        pagamentoLink: k.pagamento_link,
        grupoCriado: !!k.grupo_chat_id,
        podeEditarTexto: k.situacao === "rascunho",
      })),
    };
  }

  const subpastas = (c.drive_subpastas as Record<string, string> | null) ?? {};
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/clientes" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Clientes
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{s("nome")}</h1>
      </div>
      <Suspense>
        <FichaDoCliente
          id={id}
          podeGerenciar={ctx.permissoes.has("clientes.gerenciar")}
          dados={{
            id,
            nome: s("nome"),
            razaoSocial: s("razao_social"),
            documento: s("documento"),
            segmento: s("segmento"),
            responsavelNome: s("responsavel_nome"),
            whatsapp: s("whatsapp"),
            email: s("email"),
            cidade: s("cidade"),
            instagram: s("instagram"),
            site: s("site"),
            observacoes: s("observacoes"),
            situacao: c.situacao as SituacaoDoCliente,
            empresas: ((empresas.data ?? []) as Array<{ nome: string; documento: string | null }>).map((e) => ({
              nome: e.nome,
              documento: e.documento ?? "",
            })),
          }}
          organizacaoId={(c.organization_id as string | null) ?? null}
          organizacoes={((orgs.data ?? []) as Array<{ id: string; display_name: string | null }>).map((o) => ({
            id: o.id,
            nome: o.display_name ?? "Sem nome",
          }))}
          contratacoes={((contratacoes.data ?? []) as Array<Record<string, unknown>>).map((k) => ({
            id: k.id as string,
            tipo: k.tipo as "recorrente" | "avulsa",
            servicos: (k.servicos as string[]) ?? [],
            quantidades: lerQuantidades(k.quantidades),
            inicio: (k.inicio as string | null) ?? "",
            fim: (k.fim as string | null) ?? "",
            situacao: k.situacao as "proposta" | "ativa" | "pausada" | "encerrada",
            observacoes: (k.observacoes as string | null) ?? "",
          }))}
          equipe={((equipe.data ?? []) as Array<{ membro_id: string }>).map((e) => e.membro_id)}
          membros={(membros.data ?? []) as Array<{ id: string; nome: string }>}
          arquivos={(arquivos.data ?? []) as Array<{ id: string; nome: string; link: string; subpasta: string; criado_em: string }>}
          drive={{
            conectado: drive.conectado,
            pastaUrl: c.drive_pasta_id ? `https://drive.google.com/drive/folders/${c.drive_pasta_id as string}` : null,
            subpastasProntas: Object.keys(subpastas).length,
          }}
          tarefas={tarefas}
          apoio={apoio}
          meuMembroId={ctx.membro?.id ?? null}
          podeCriarTarefa={ctx.permissoes.has("tarefas.criar")}
          podeAtribuir={ctx.permissoes.has("tarefas.atribuir")}
          reunioes={reunioes}
          apoioDaAgenda={apoioAgenda}
          podeGerenciarCalendario={ctx.permissoes.has("calendario.gerenciar")}
          agendaLiberada={drive.agendaLiberada}
          trilha={trilha}
          formulario={
            f
              ? {
                  id: f.id,
                  situacao: situacaoDoLink(f, new Date()) as "valido" | "enviado" | "cancelado" | "expirado",
                  criadoEm: f.criado_em,
                  expiraEm: f.expira_em,
                  enviadoEm: f.enviado_em,
                  respostas: respostas?.success ? respostas.data : null,
                }
              : null
          }
          cofre={cofre}
          podeVerSenhas={ctx.permissoes.has("cofre.ver_senhas")}
          contratos={contratos}
          aprovacoes={((aprovacoes.data ?? []) as Array<{
            id: string;
            tipo: AprovacaoDaFicha["tipo"];
            titulo: string;
            link: string | null;
            versao: number;
            situacao: AprovacaoDaFicha["situacao"];
            comentario: string | null;
            pedido_em: string;
            respondido_em: string | null;
            tarefa_id: string | null;
          }>).map((a) => ({
            id: a.id,
            tipo: a.tipo,
            titulo: a.titulo,
            link: a.link,
            versao: a.versao,
            situacao: a.situacao,
            comentario: a.comentario,
            pedidoEm: a.pedido_em,
            respondidoEm: a.respondido_em,
            tarefaId: a.tarefa_id,
          }))}
        />
      </Suspense>
    </div>
  );
}
