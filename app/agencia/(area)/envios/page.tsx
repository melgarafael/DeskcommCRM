import { CentralDeEnvios, type EnvioDaTela } from "@/components/agencia/envios/CentralDeEnvios";
import type { Prefixo } from "@/components/agencia/envios/NovoEnvio";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { TIPOS_DE_APROVACAO, type SituacaoDaAprovacao, type TipoDeAprovacao } from "@/lib/agencia/aprovacoes/vocabulario";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { linksDeLeitura } from "@/lib/agencia/envios/armazenamento";
import { idSchema } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Envios · Agência" };
export const dynamic = "force-dynamic";

interface Linha {
  id: string;
  cliente_id: string;
  tipo: TipoDeAprovacao;
  titulo: string;
  descricao: string | null;
  link: string | null;
  texto: string | null;
  arquivo_caminho: string | null;
  arquivo_mime: string | null;
  arquivo_bytes: number | null;
  arquivo_apagado_em: string | null;
  versao: number;
  situacao: SituacaoDaAprovacao;
  comentario: string | null;
  pedido_em: string;
  respondido_em: string | null;
  tarefa_id: string | null;
  agencia_clientes: { nome: string } | null;
}

/** Envios (docs/agencia/SPEC-envios.md). `?novo=1&cliente=…&tarefa=…` abre o formulário já preenchido. */
export default async function PaginaDosEnvios({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  const clienteFiltro = typeof sp.cliente === "string" && idSchema.safeParse(sp.cliente).success ? sp.cliente : "";
  const db = createAdminClient();

  let consulta = db
    .from("agencia_aprovacoes")
    .select(
      "id, cliente_id, tipo, titulo, descricao, link, texto, arquivo_caminho, arquivo_mime, arquivo_bytes, arquivo_apagado_em, versao, situacao, comentario, pedido_em, respondido_em, tarefa_id, agencia_clientes(nome)",
    )
    .order("pedido_em", { ascending: false })
    .limit(300);
  if (clienteFiltro) consulta = consulta.eq("cliente_id", clienteFiltro);
  const [{ data }, { data: clientes }] = await Promise.all([
    consulta,
    db.from("agencia_clientes").select("id, nome").not("organization_id", "is", null).not("situacao", "in", "(encerrado,perdido)").order("nome"),
  ]);
  const linhas = ((data ?? []) as unknown as Linha[]).filter((l) => podeVerCliente(alcance, l.cliente_id) && l.situacao !== "cancelado");
  const ids = linhas.map((l) => l.id);
  const [{ data: copias }, links] = await Promise.all([
    ids.length ? db.from("agencia_envios_copias").select("aprovacao_id, situacao, erro, drive_link, enviados").in("aprovacao_id", ids) : Promise.resolve({ data: [] }),
    linksDeLeitura(linhas.filter((l) => l.arquivo_caminho && !l.arquivo_apagado_em).map((l) => l.arquivo_caminho!)),
  ]);
  const copiaDe = new Map(((copias ?? []) as Array<{ aprovacao_id: string; situacao: "aguardando" | "copiando" | "copiado" | "falhou"; erro: string | null; drive_link: string | null; enviados: number }>).map((c) => [c.aprovacao_id, c]));

  const envios: EnvioDaTela[] = linhas.map((l) => {
    const c = copiaDe.get(l.id);
    return {
      id: l.id,
      clienteId: l.cliente_id,
      clienteNome: l.agencia_clientes?.nome ?? "",
      tipo: l.tipo,
      titulo: l.titulo,
      descricao: l.descricao,
      versao: l.versao,
      situacao: l.situacao,
      comentario: l.comentario,
      pedidoEm: l.pedido_em,
      respondidoEm: l.respondido_em,
      tarefaId: l.tarefa_id,
      bytes: l.arquivo_bytes,
      material: {
        texto: l.texto,
        url: l.arquivo_caminho ? (links.get(l.arquivo_caminho) ?? null) : null,
        mime: l.arquivo_mime,
        link: l.link,
        apagado: !!l.arquivo_apagado_em,
      },
      copia: c
        ? { situacao: c.situacao, erro: c.erro, driveLink: c.drive_link, porcento: l.arquivo_bytes ? Math.floor((Number(c.enviados) / l.arquivo_bytes) * 100) : 0 }
        : null,
    };
  });

  const opcoes = ((clientes ?? []) as Array<{ id: string; nome: string }>).filter((c) => alcance.todos || alcance.ids.has(c.id));
  const tipoPedido = typeof sp.tipo === "string" && (TIPOS_DE_APROVACAO as readonly string[]).includes(sp.tipo) ? (sp.tipo as TipoDeAprovacao) : undefined;
  const tarefa = typeof sp.tarefa === "string" && idSchema.safeParse(sp.tarefa).success ? sp.tarefa : null;
  const novo: Prefixo | null = sp.novo ? { clienteId: clienteFiltro || undefined, tipo: tipoPedido, tarefaId: tarefa, titulo: typeof sp.titulo === "string" ? sp.titulo.slice(0, 200) : undefined } : null;

  return (
    <CentralDeEnvios
      envios={envios}
      clientes={opcoes}
      clienteFiltro={clienteFiltro}
      abrir={typeof sp.abrir === "string" ? sp.abrir : null}
      novo={novo}
      podeEnviar={ctx.permissoes.has("tarefas.criar")}
    />
  );
}
