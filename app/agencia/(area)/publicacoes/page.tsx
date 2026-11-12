import { redirect } from "next/navigation";

import { CalendarioDePublicacoes } from "@/components/agencia/publicacoes/CalendarioDePublicacoes";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { diaDe, gradeDoMes, horaLocal, meiaNoite, somarDias } from "@/lib/agencia/calendario/regras";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { mesDe, primeiroDia, type Formato, type Rede, type SituacaoDaPublicacao } from "@/lib/agencia/publicacoes/regras";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Publicações · Agência" };
export const dynamic = "force-dynamic";

interface Linha {
  id: string;
  cliente_id: string;
  titulo: string;
  rede: Rede;
  formato: Formato;
  quando: string;
  legenda: string | null;
  midia_url: string | null;
  responsavel_id: string | null;
  situacao: SituacaoDaPublicacao;
  auto_publicar: boolean;
  comentario: string | null;
  post_url: string | null;
  erro: string | null;
}

/** O calendário de postagens dos clientes (docs/agencia/SPEC-publicacoes.md). */
export default async function PaginaDasPublicacoes({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await requireAreaDaAgencia();
  const alcance = await carregarAlcance(ctx);
  const hoje = diaDe(new Date().toISOString());
  const mes = typeof sp.mes === "string" && /^\d{4}-\d{2}$/.test(sp.mes) ? sp.mes : mesDe(hoje);
  const clienteFiltro = typeof sp.cliente === "string" ? sp.cliente : "";
  const abrir = typeof sp.abrir === "string" ? sp.abrir : null;

  const grade = gradeDoMes(primeiroDia(mes));
  const de = meiaNoite(grade[0]![0]!).toISOString();
  const ate = meiaNoite(somarDias(grade[grade.length - 1]![6]!, 1)).toISOString();

  const db = createAdminClient();
  let consulta = db
    .from("agencia_publicacoes")
    .select("id, cliente_id, titulo, rede, formato, quando, legenda, midia_url, responsavel_id, situacao, auto_publicar, comentario, post_url, erro")
    .gte("quando", de)
    .lt("quando", ate)
    .order("quando")
    .limit(1000);
  if (clienteFiltro) consulta = consulta.eq("cliente_id", clienteFiltro);
  const [{ data: pubs }, { data: clientes }, aberta] = await Promise.all([
    consulta,
    db.from("agencia_clientes").select("id, nome").not("situacao", "in", "(encerrado,perdido)").order("nome"),
    // A publicação do aviso pode estar fora do mês aberto.
    abrir ? db.from("agencia_publicacoes").select("quando").eq("id", abrir).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const opcoes = ((clientes ?? []) as Array<{ id: string; nome: string }>).filter((c) => alcance.todos || alcance.ids.has(c.id));
  const nomes = new Map(opcoes.map((c) => [c.id, c.nome]));
  const visiveis = ((pubs ?? []) as Linha[]).filter((p) => podeVerCliente(alcance, p.cliente_id));
  const quandoAberta = (aberta.data as { quando: string } | null)?.quando;
  if (quandoAberta && mesDe(diaDe(quandoAberta)) !== mes && !sp.mes) {
    redirect(`/agencia/publicacoes?mes=${mesDe(diaDe(quandoAberta))}&abrir=${abrir}`);
  }

  return (
    <CalendarioDePublicacoes
      mes={mes}
      hoje={hoje}
      grade={grade}
      clienteFiltro={clienteFiltro}
      abrir={abrir}
      clientes={opcoes}
      publicacoes={visiveis.map((p) => ({
        id: p.id,
        clienteId: p.cliente_id,
        clienteNome: nomes.get(p.cliente_id) ?? "",
        titulo: p.titulo,
        rede: p.rede,
        formato: p.formato,
        dia: diaDe(p.quando),
        hora: horaLocal(p.quando),
        legenda: p.legenda ?? "",
        midiaUrl: p.midia_url ?? "",
        responsavelId: p.responsavel_id,
        situacao: p.situacao,
        autoPublicar: p.auto_publicar,
        comentario: p.comentario,
        postUrl: p.post_url,
        erro: p.erro,
      }))}
    />
  );
}
