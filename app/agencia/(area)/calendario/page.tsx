import { Suspense } from "react";

import { CalendarioCliente, type PrazoNaAgenda, type Vista } from "@/components/agencia/calendario/CalendarioCliente";
import { requireAreaDaAgencia } from "@/lib/agencia/acesso";
import { estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { apoioDaAgenda } from "@/lib/agencia/calendario/apoio";
import { carregarQuemOlhaAgenda, carregarReuniao, listarReunioes } from "@/lib/agencia/calendario/consultas";
import { ehDia, gradeDoMes, inicioDaSemana, meiaNoite, somarDias } from "@/lib/agencia/calendario/regras";
import { idSchema } from "@/lib/agencia/schemas";
import { carregarQuemOlha, listarTarefas } from "@/lib/agencia/tarefas/consultas";
import { diaLocal } from "@/lib/agencia/tarefas/regras";

export const metadata = { title: "Calendário · Agência" };
export const dynamic = "force-dynamic";

const VISTAS: readonly Vista[] = ["semana", "mes", "proximos"];
/** "Próximos" olha até dois meses à frente. */
const DIAS_DOS_PROXIMOS = 60;

type Busca = Record<string, string | string[] | undefined>;

function um(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** O calendário da agência (docs/agencia/SPEC-calendario.md › Telas). */
export default async function PaginaDoCalendario({ searchParams }: { searchParams: Promise<Busca> }) {
  const busca = await searchParams;
  const ctx = await requireAreaDaAgencia();
  const hoje = diaLocal(new Date());
  const vista = VISTAS.find((v) => v === um(busca.vista)) ?? null;
  const dia = ehDia(um(busca.dia)) ? um(busca.dia) : hoje;
  const cliente = idSchema.safeParse(um(busca.cliente)).success ? um(busca.cliente) : "";
  const pessoa = idSchema.safeParse(um(busca.pessoa)).success ? um(busca.pessoa) : "";
  const abrir = idSchema.safeParse(um(busca.abrir)).success ? um(busca.abrir) : null;

  // O período que a vista pede. Sem vista, o computador vê a semana e o celular os próximos: carrega os dois.
  const semana = { de: inicioDaSemana(dia), ate: somarDias(inicioDaSemana(dia), 7) };
  const grade = gradeDoMes(dia);
  const proximos = { de: hoje, ate: somarDias(hoje, DIAS_DOS_PROXIMOS) };
  const faixa =
    vista === "semana"
      ? semana
      : vista === "mes"
        ? { de: grade[0]![0]!, ate: somarDias(grade.at(-1)![6]!, 1) }
        : vista === "proximos"
          ? proximos
          : { de: semana.de < proximos.de ? semana.de : proximos.de, ate: semana.ate > proximos.ate ? semana.ate : proximos.ate };
  const de = meiaNoite(faixa.de);
  const ate = meiaNoite(faixa.ate);

  const quem = await carregarQuemOlhaAgenda(ctx);
  const [reunioesDoPeriodo, tarefas, apoio, drive] = await Promise.all([
    listarReunioes(quem, { de, ate, ...(cliente ? { clienteId: cliente } : {}) }),
    ctx.membro || ctx.permissoes.has("tarefas.ver_todas") ? listarTarefas(await carregarQuemOlha(ctx), cliente ? { clienteId: cliente } : {}) : [],
    apoioDaAgenda(quem),
    estadoDoDrive(),
  ]);

  let reunioes = pessoa ? reunioesDoPeriodo.filter((r) => r.membros.includes(pessoa)) : reunioesDoPeriodo;
  // Aberta por um aviso: pode estar fora do período da tela.
  if (abrir && !reunioes.some((r) => r.id === abrir)) {
    const r = await carregarReuniao(abrir, quem);
    if (r) reunioes = [...reunioes, r];
  }

  const prazos: PrazoNaAgenda[] = tarefas
    .filter((t) => t.prazo && t.coluna !== "concluido")
    .filter((t) => (pessoa ? t.responsaveis.includes(pessoa) : true))
    .filter((t) => {
      const ms = new Date(t.prazo!).getTime();
      return ms >= de.getTime() && ms < ate.getTime();
    })
    .map((t) => ({ id: t.id, titulo: t.titulo, prazo: t.prazo!, clienteNome: t.clienteNome }));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Calendário</h1>
        <p className="text-sm text-muted-foreground">Reuniões com os clientes e os prazos das tarefas, no horário de Brasília.</p>
      </div>
      <Suspense>
        <CalendarioCliente
          vista={vista}
          dia={dia}
          hoje={hoje}
          reunioes={reunioes}
          prazos={prazos}
          apoio={apoio}
          filtros={{ cliente, pessoa }}
          meuMembroId={ctx.membro?.id ?? null}
          podeGerenciar={ctx.permissoes.has("calendario.gerenciar")}
          agendaLiberada={drive.agendaLiberada}
          abrirId={abrir}
        />
      </Suspense>
    </div>
  );
}
