/**
 * A CAMPANHA POR TRANSMISSÃO (migration 0712): a lista inteira entregue ao
 * provedor numa chamada, e o relatório dele trazido de volta, destinatário a
 * destinatário, a cada rodada.
 *
 * ═══ O caminho ═══
 *
 *  1. A primeira rodada com a campanha `running` confere a janela (a da campanha
 *     e a do número), revalida cada pessoa (bloqueio, opt-out, exclusão — como a
 *     rodada de sempre: a pessoa pode ter pedido para parar depois da
 *     preparação), cria a transmissão, grava o id NA CAMPANHA antes de qualquer
 *     telefone sair, reserva os destinatários (`sending`), entrega os telefones e
 *     manda.
 *  2. Cada rodada seguinte lê o relatório do provedor e leva a cada destinatário
 *     o que aconteceu: enviado, entregue, lido ou falhou, com o código. Quando o
 *     provedor termina e ninguém está pendente, a campanha conclui.
 *  3. O eco de cada mensagem chega pelo webhook com o id da transmissão: a
 *     ingestão acha aqui o destinatário (`ecoDaTransmissao`), grava a linha com o
 *     texto do modelo e a liga ao destinatário — daí em diante entrega e leitura
 *     chegam também pelo gatilho de ack, como em qualquer campanha.
 *
 * ═══ Por que o id é gravado antes dos telefones ═══
 *
 * Se a rodada cair entre criar e mandar, a seguinte encontra o id, lê o estado
 * (`draft`) e termina o serviço — os telefones repetidos o provedor ignora. Sem
 * o id gravado, ela criaria uma SEGUNDA transmissão, e a lista receberia em
 * dobro.
 *
 * ═══ Por que o rascunho é conferido antes de ser reaproveitado ═══
 *
 * O provedor só ACRESCENTA telefone: não existe tirar destinatário de um
 * rascunho, e `enviar` manda a quem estiver nele. Uma campanha pausada, ou uma
 * rodada que caiu, deixa no rascunho telefones que podem esperar por dias — e
 * quem pedir para sair nesse meio tempo sairia da nossa lista e continuaria na
 * dele. Por isso, com id existente, o rascunho é lido antes: se traz alguém fora
 * da lista revalidada agora, ou alguém que não dá para ler, ele é APAGADO e a
 * rodada seguinte cria outro, só com quem pode receber. Vale também para quem
 * sai da fila entre a leitura e a reserva: o telefone dele pode já estar lá.
 *
 * Subir uma lista longa leva tempo, então a conferência se repete depois de
 * `adicionar`, logo antes de `enviar`: o status de toda a lista, os vetos por
 * pessoa e o telefone, refeitos. Se alguém saiu, ou se o número que subiu já não é
 * o da pessoa, o rascunho é apagado e a fila devolvida. Entre
 * essa releitura e o `enviar` sobra uma janela que não dá para fechar daqui, porque
 * o provedor não aceita condição no envio: quem sair nela pode receber.
 *
 * ═══ Por que os valores do modelo são os do destinatário ═══
 *
 * O provedor recebe um valor por variável, o mesmo para todos. A rota só deixa
 * escolher a transmissão quando toda variável é texto fixo; mesmo assim, o valor
 * que sai é o CONGELADO na preparação, conferido igual em todos os destinatários
 * — o mesmo que a rodada de sempre mandaria a cada um. Se algum diferir, a
 * campanha pausa em vez de mandar a alguém um texto que não era o dele.
 *
 * ═══ Por que o teto do número é conferido ANTES de entregar ═══
 *
 * O broadcast não espaça mensagens nem manda em partes: a lista sai inteira, de
 * uma vez. Então o freio do número não pode ser o livro do ritmo
 * (`recordSends`) — ele registra o que saiu, depois que saiu. A lista só é
 * entregue se COUBER no que resta do teto diário do número e dos máximos da
 * campanha, descontado o que cada um já gastou (`tetoDaTransmissao`); se não
 * couber, a campanha pausa com a frase, antes de criar a transmissão. Revisão do
 * #3126: sem isto, o teto não era consultado, mas o volume era cobrado dele.
 *
 * ═══ Por que o volume é contado por lote, de novo a cada rodada ═══
 *
 * O envio e o livro não são a mesma transação. O livro pode falhar logo depois
 * do `enviar`, a rodada pode cair ali, e uma rodada sobreposta só vê a transmissão
 * já fora de rascunho. Sem repetir, esse volume nunca chegava ao teto do número, e
 * a campanha seguinte passava por ele. Então quem manda conta, e quem acompanha
 * conta de novo: o id de cada linha do livro deriva da transmissão, e a repetição
 * não soma (`recordSends`).
 *
 * ═══ Por que `sending` sem id não é reserva ═══
 *
 * A reserva do broadcast nasce depois do id. Sem id, `sending` é mensagem que a
 * rodada de sempre pode estar mandando: a campanha trocou de velocidade com ela
 * em voo. Entregá-la ao provedor seria mandar de novo, e deixá-la de lado não
 * basta, porque depois de criado o id ninguém mais distinguiria essa linha de uma
 * reserva. Por isso a transmissão só nasce sem `sending` nenhum.
 *
 * Nunca lança para o cron por falha do provedor: limite de velocidade espera a
 * próxima rodada; o resto pausa a campanha com a frase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decidePacing } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSends } from "@/lib/agent-engine/pacing/store";
import { buildComponents, slotKey } from "@/lib/channels/meta/build-components";
import {
  ESTADOS_FINAIS_DA_TRANSMISSAO,
  ErroDaTransmissao,
  digitosDoTelefone,
  transmissaoDaConexao,
  type DestinatarioDaTransmissao,
  type EstadoDaTransmissao,
  type ModeloDaTransmissao,
  type OpsDeTransmissao,
} from "@/lib/channels/transmissao";
import { logger } from "@/lib/logger";

import { variaveisPorPessoa } from "./conteudo-do-canal";
import { motivoParaExcluir, recusouMarketing, statusDaSaida } from "./elegibilidade";
import { estadoDeEnvio } from "./estado-de-envio";
import { hashDoEndereco } from "./exclusoes";
import { variaveisDaCampanhaSchema } from "./modelo";
import { contratoDe, definicaoDaCampanha } from "./modelo-da-conexao";
import { podeMandarAgora } from "./ritmo";
import type { MotivoDeExclusao } from "./tipos";

/** O que a rodada precisa da campanha — as colunas vêm de `rodada.ts`. */
export interface CampanhaDaTransmissao {
  id: string;
  organization_id: string;
  channel_session_id: string;
  name: string;
  provider_template_name: string | null;
  provider_template_language: string | null;
  provider_template_variables: unknown;
  provider_broadcast_id: string | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  /** Os máximos da própria campanha. A tela os deixa em branco no broadcast; a API não. */
  teto_diario?: number | null;
  teto_horario?: number | null;
}

export interface ResultadoDaTransmissao {
  enviadas: number;
  pulados: number;
  concluidas: number;
  detalhe: string;
}

/** Páginas lidas do banco: 200 × 1.000 destinatários. */
const POR_PAGINA = 1_000;
const MAX_PAGINAS = 200;
/**
 * O relatório do provedor vem de 100 em 100. O teto de páginas dele é medido
 * pelo tamanho da lista (`paginasDoRelatorio`), nunca fixo: com 200 fixas, uma
 * lista acima de 20.000 terminava a leitura pelo teto, e quem ficou de fora do
 * pedaço lido era fechado como falha — gente que o provedor entregou.
 */
const POR_PAGINA_DO_PROVEDOR = 100;
/** Ids por filtro `in (...)`: a URL do PostgREST tem teto, e lista longa corta sem aviso. */
const IDS_POR_FILTRO = 200;

const SO_O_CONTADOR = { enviadas: 0, pulados: 0, concluidas: 0 } as const;

export async function rodarCampanhaEmTransmissao(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
): Promise<ResultadoDaTransmissao> {
  const ops = await transmissaoDaConexao(admin, {
    organizationId: campanha.organization_id,
    channelSessionId: campanha.channel_session_id,
  });
  if (!ops) {
    await pausar(admin, campanha.id, agora, {
      codigo: "transmissao_indisponivel",
      detalhe: "Este número não faz broadcast. Troque a velocidade para Rápido e retome a campanha.",
    });
    return { ...SO_O_CONTADOR, detalhe: "pausada:transmissao_indisponivel" };
  }

  try {
    const id = campanha.provider_broadcast_id;
    if (!id) return await entregarAoProvedor(admin, campanha, ops, agora, null);
    const { estado } = await ops.ler(id);
    if (estado === "draft") return await entregarAoProvedor(admin, campanha, ops, agora, id);
    return await acompanhar(admin, campanha, ops, id, estado, agora);
  } catch (err) {
    if (!(err instanceof ErroDaTransmissao)) throw err;
    if (err.ehLimiteDeVelocidade) return { ...SO_O_CONTADOR, detalhe: "limite:429" };
    logger.warn("[campanha] transmissão recusada pelo provedor", {
      campanha: campanha.id,
      status: err.status,
      codigo: err.codigo,
    });
    await pausar(admin, campanha.id, agora, {
      codigo: `transmissao_${err.codigo}`.slice(0, 80),
      detalhe: `O provedor recusou o broadcast: ${err.message}`.slice(0, 500),
    });
    return { ...SO_O_CONTADOR, detalhe: `pausada:transmissao_${err.codigo}` };
  }
}

// ─── 1. Entregar a lista ────────────────────────────────────────────────────

async function entregarAoProvedor(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  ops: OpsDeTransmissao,
  agora: Date,
  idExistente: string | null,
): Promise<ResultadoDaTransmissao> {
  const janela = await janelaAberta(admin, campanha, agora);
  if (!janela.aberta) return { ...SO_O_CONTADOR, detalhe: `ritmo:${janela.motivo}` };

  if (!idExistente) {
    const saindo = await quemEstaSaindoSemId(admin, campanha.id);
    if (saindo === "outra_rodada") return { ...SO_O_CONTADOR, detalhe: "ja_entregue" };
    if (saindo === "outra_velocidade") {
      logger.warn("[campanha] broadcast com envio da velocidade anterior em voo — pausada", { campanha: campanha.id });
      await pausar(admin, campanha.id, agora, { codigo: "transmissao_envio_em_voo", detalhe: DETALHE_ENVIO_EM_VOO });
      return { ...SO_O_CONTADOR, detalhe: "pausada:transmissao_envio_em_voo" };
    }
  }

  const fila = await revalidar(admin, campanha, agora, "pending");
  // Quem uma rodada anterior reservou e não chegou a sair: a espera pode ter sido
  // de horas (janela, canal fora do ar), e a pessoa pode ter saído da lista nela.
  const emEspera = idExistente ? await revalidar(admin, campanha, agora, "sending") : { prontos: [], pulados: 0 };
  const prontos = fila.prontos;
  const emVoo = emEspera.prontos;
  const pulados = fila.pulados + emEspera.pulados;

  if (idExistente) {
    const lista = new Set([...prontos, ...emVoo].map((d) => digitosDoTelefone(d.telefone)));
    if (!(await rascunhoSoTemALista(ops, idExistente, lista))) {
      return await descartarRascunho(admin, campanha, ops, idExistente, emVoo, pulados, agora);
    }
  }

  if (prontos.length === 0 && emVoo.length === 0) {
    const concluidas = await concluirSeNadaEmVoo(admin, campanha.id, agora);
    return { enviadas: 0, pulados, concluidas, detalhe: concluidas > 0 ? "concluida" : "aguardando" };
  }

  // O teto ANTES de criar a transmissão: o que sai daqui sai inteiro.
  const tamanho = prontos.length + emVoo.length;
  const tetoDiarioDaCampanha = campanha.teto_diario ?? null;
  const tetoHorarioDaCampanha = campanha.teto_horario ?? null;
  const gasto =
    tetoDiarioDaCampanha !== null || tetoHorarioDaCampanha !== null
      ? await estadoDeEnvio(admin, campanha.id, agora, janela.fuso)
      : null;
  const teto = tetoDaTransmissao({
    tamanho,
    limiteDoNumero: janela.limiteDoNumero,
    enviadosHojeNoNumero: janela.enviadosHoje,
    tetoDiarioDaCampanha,
    tetoHorarioDaCampanha,
    enviadasHojeNaCampanha: gasto?.enviadasHoje ?? 0,
    enviadasNaHoraNaCampanha: gasto?.enviadasNaUltimaHora ?? 0,
  });
  if (!teto.cabe) {
    logger.warn("[campanha] broadcast acima do teto — pausada antes de entregar", {
      campanha: campanha.id,
      tamanho,
      livre: teto.livre,
      de: teto.de,
    });
    await pausar(admin, campanha.id, agora, {
      codigo: "transmissao_acima_do_teto",
      detalhe: teto.de === "numero" ? DETALHE_ACIMA_DO_TETO_DO_NUMERO : DETALHE_ACIMA_DO_TETO_DA_CAMPANHA,
    });
    return { ...SO_O_CONTADOR, pulados, detalhe: `pausada:transmissao_acima_do_teto:${tamanho}>${teto.livre}` };
  }

  const modelo = await modeloDaTransmissao(admin, campanha, [...prontos, ...emVoo]);
  if (!modelo.ok) {
    await pausar(admin, campanha.id, agora, { codigo: modelo.codigo, detalhe: modelo.detalhe });
    return { ...SO_O_CONTADOR, pulados, detalhe: `pausada:${modelo.codigo}` };
  }

  let id = idExistente;
  if (!id) {
    const criada = await ops.criar({ nome: campanha.name, modelo: modelo.modelo });
    const { data, error } = await admin
      .from("campaigns")
      .update({ provider_broadcast_id: criada.id })
      .eq("id", campanha.id)
      .eq("status", "running")
      .is("provider_broadcast_id", null)
      .select("id");
    if (error) {
      // Erro de banco NÃO é corrida perdida: tratado como corrida, a rodada
      // seguinte criaria e descartaria outra transmissão, para sempre, sem log.
      // A nossa é descartada (sem o id gravado, ela viraria uma segunda) e a
      // campanha pausa com a frase.
      logger.warn("[campanha] id da transmissão não gravado", { campanha: campanha.id, codigo: error.code ?? null });
      // Recém-criada e sem telefone: se o descarte falhar, sobra um rascunho vazio.
      await ops.descartar(criada.id).catch(() => false);
      await pausar(admin, campanha.id, agora, {
        codigo: "transmissao_id_nao_gravado",
        detalhe:
          "O CRM não conseguiu guardar o broadcast criado no provedor e o descartou, para a lista não sair duas vezes. Retome a campanha para tentar de novo.",
      });
      return { ...SO_O_CONTADOR, pulados, detalhe: "pausada:transmissao_id_nao_gravado" };
    }
    if ((data ?? []).length === 0) {
      // Outra rodada chegou antes (ou a campanha saiu de `running`): a nossa
      // transmissão fica vazia no rascunho, e é ela que se descarta. Sem telefone,
      // um descarte que falhe não deixa nada para sair.
      await ops.descartar(criada.id).catch(() => false);
      return { ...SO_O_CONTADOR, pulados, detalhe: "ja_entregue" };
    }
    id = criada.id;
  }

  const reservados = await reservar(admin, campanha, prontos, agora);
  const lista = [...reservados, ...emVoo];
  if (idExistente && reservados.length < prontos.length) {
    // Alguém saiu da fila depois da conferência, e o rascunho já tinha o telefone.
    return await descartarRascunho(admin, campanha, ops, idExistente, lista, pulados, agora);
  }
  let estado: EstadoDaTransmissao;
  let puladosNoProvedor: number;
  try {
    puladosNoProvedor = (
      await ops.adicionar(
        id,
        lista.map((d) => d.telefone),
      )
    ).pulados;
    // Quem saiu enquanto os telefones subiam já está no rascunho. A janela entre
    // esta releitura e o `enviar` não fecha: está declarada no cabeçalho.
    const relida = await revalidar(admin, campanha, agora, "sending");
    // Cancelar um rascunho no provedor não o trava (o `cancelar` dele responde
    // 400), e subir uma lista longa leva tempo: quem cancelou ou pausou nesse
    // meio tempo tem de vencer, porque depois do `enviar` a lista inteira saiu.
    const status = await statusDaCampanha(admin, campanha.id);
    if (status !== "running") {
      if (status === "cancelled") {
        await fecharQuemFicou(admin, campanha.id, "cancelled", agora);
        await pararNoProvedor(admin, ops, campanha.id, id);
      } else {
        await devolverAFila(
          admin,
          reservados.map((d) => d.id),
        );
      }
      return { ...SO_O_CONTADOR, pulados: pulados + relida.pulados, detalhe: `parada_antes_de_mandar:${status}` };
    }
    // O id sozinho não basta: o que o `enviar` usa é o telefone que já subiu.
    const aindaNaLista = new Map(relida.prontos.map((d) => [d.id, digitosDoTelefone(d.telefone)]));
    if (lista.some((d) => aindaNaLista.get(d.id) !== digitosDoTelefone(d.telefone))) {
      return await descartarRascunho(admin, campanha, ops, id, lista, pulados + relida.pulados, agora);
    }
    estado = (await ops.enviar(id)).estado;
  } catch (err) {
    // 400 é "não dá neste estado" — a mesma leitura que o `cancelar` já faz. Com
    // duas rodadas sobrepostas, as duas leem `draft` e as duas mandam: a segunda
    // recebe 400 porque a primeira JÁ mandou. Pausar aqui congelaria a campanha
    // com o provedor entregando; quem decide é o estado relido.
    if (err instanceof ErroDaTransmissao && err.status === 400) {
      const relido = await ops.ler(id).catch(() => null);
      if (relido && relido.estado !== "draft") {
        return await acompanhar(admin, campanha, ops, id, relido.estado, agora);
      }
    }
    // Nada saiu (ou não dá para saber): quem foi reservado volta à fila. Se o
    // provedor tiver mandado mesmo assim, o relatório da próxima rodada corrige
    // — `desfechoDaTransmissao` aceita `pending` como ponto de partida.
    await devolverAFila(
      admin,
      reservados.map((d) => d.id),
    );
    throw err;
  }

  // Fora do `try` de propósito: a lista JÁ saiu. Uma falha ao contar no livro do
  // ritmo não pode devolver à fila quem o provedor está entregando agora. Conta
  // como disparo, e o teto que ela consome já foi conferido lá em cima
  // (`tetoDaTransmissao`): o livro não freia nada, ele registra.
  await contarNoRitmoDoNumero(campanha, id, agora, lista.length);
  return {
    enviadas: lista.length,
    pulados,
    concluidas: 0,
    // `skipped` do provedor é número sem WhatsApp OU telefone que já estava na
    // lista — o caminho da retomada repõe os mesmos. O nome não escolhe um dos dois.
    detalhe: `transmissao:${estado}:${lista.length}${puladosNoProvedor > 0 ? `:pulados_pelo_provedor_${puladosNoProvedor}` : ""}`,
  };
}

/**
 * Leva o volume ao livro do ritmo do número. Repetir não soma: o lote é a
 * transmissão. Falha aqui não para nada, porque a lista já saiu e a rodada de
 * acompanhamento conta de novo.
 */
async function contarNoRitmoDoNumero(
  campanha: CampanhaDaTransmissao,
  id: string,
  saiuEm: Date,
  quantas: number,
): Promise<void> {
  try {
    await recordSends(
      getRequestPool(),
      campanha.organization_id,
      campanha.channel_session_id,
      saiuEm,
      quantas,
      `${campanha.id}:${id}`,
    );
  } catch (err) {
    logger.warn("[campanha] envios da transmissão não contados no ritmo do número", {
      campanha: campanha.id,
      motivo: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Há `sending` numa campanha sem id de transmissão? Uma rodada sobreposta grava o
 * id ANTES de reservar: se ele está lá agora, o `sending` é dela. Se não está, é
 * de outra velocidade.
 */
async function quemEstaSaindoSemId(
  admin: SupabaseClient,
  campanhaId: string,
): Promise<"outra_rodada" | "outra_velocidade" | null> {
  const { count, error } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .eq("status", "sending");
  if (error) throw new Error(`destinatários em voo: ${error.message}`);
  if (!count) return null;
  const { data, error: erroDaCampanha } = await admin
    .from("campaigns")
    .select("provider_broadcast_id")
    .eq("id", campanhaId)
    .maybeSingle();
  if (erroDaCampanha) throw new Error(`id da transmissão: ${erroDaCampanha.message}`);
  return (data as { provider_broadcast_id: string | null } | null)?.provider_broadcast_id
    ? "outra_rodada"
    : "outra_velocidade";
}

/**
 * O rascunho do provedor só tem gente da lista? Quem ele traz sem dar para ler
 * conta como fora, e o mesmo vale para um relatório que não acaba e para uma
 * última página cuja conta não fecha com o total do provedor, ou sem total: na
 * dúvida, o rascunho é refeito, que custa uma rodada; mandar a quem saiu não tem
 * conserto.
 */
async function rascunhoSoTemALista(ops: OpsDeTransmissao, id: string, lista: ReadonlySet<string>): Promise<boolean> {
  let pular = 0;
  const teto = paginasDoRelatorio(lista.size);
  for (let pagina = 0; pagina < teto; pagina++) {
    const p = await ops.destinatarios(id, { pular, quantos: POR_PAGINA_DO_PROVEDOR });
    if (p.itens.length < p.lidos || p.itens.some((i) => !lista.has(i.telefone))) return false;
    if (!p.temMais || p.lidos === 0) return p.total === pular + p.lidos;
    pular += p.lidos;
  }
  return false;
}

/**
 * Apaga o rascunho com gente que saiu da lista e esquece o id: a rodada seguinte
 * cria outro. O provedor primeiro, o banco depois: esquecer um id cujo envio já
 * saiu faria a lista sair em dobro. Quem estava reservado volta à fila, porque
 * `sending` sem id não existe (`encerrarTransmissao` conta com isso).
 */
async function descartarRascunho(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  ops: OpsDeTransmissao,
  id: string,
  reservados: Pronto[],
  pulados: number,
  agora: Date,
): Promise<ResultadoDaTransmissao> {
  if (!(await ops.descartar(id))) {
    // Já não é rascunho: outra rodada mandou. Quem decide é o estado relido.
    const { estado } = await ops.ler(id);
    return await acompanhar(admin, campanha, ops, id, estado, agora);
  }
  await devolverAFila(
    admin,
    reservados.map((d) => d.id),
  );
  const { error } = await admin
    .from("campaigns")
    .update({ provider_broadcast_id: null })
    .eq("id", campanha.id)
    .eq("provider_broadcast_id", id);
  if (error) throw new Error(`rascunho da transmissão: ${error.message}`);
  logger.warn("[campanha] rascunho da transmissão refeito: podia trazer quem saiu da lista", { campanha: campanha.id });
  return { ...SO_O_CONTADOR, pulados, detalhe: "rascunho_refeito" };
}

interface Pronto {
  id: string;
  telefone: string;
  valores: Record<string, string> | null;
}

/**
 * Os destinatários nesse status, com os vetos por PESSOA refeitos agora — os
 * mesmos da rodada de sempre (`rodarUmaCampanha`), em lote. Quem caiu num veto
 * sai com o motivo; o resto vai para o provedor.
 */
async function revalidar(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
  status: "pending" | "sending",
): Promise<{ prontos: Pronto[]; pulados: number }> {
  const candidatos: Array<Pronto & { motivo: MotivoDeExclusao | null; endereco: string }> = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, contact_id, recipient_address, variables, " +
          "contacts(phone_number, is_blocked, is_personal, is_anonymized, consent)",
      )
      .eq("campaign_id", campanha.id)
      .eq("status", status)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
    if (error) throw new Error(`destinatários da transmissão (${status}): ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<{
      id: string;
      contact_id: string;
      recipient_address: string | null;
      variables: unknown;
      contacts: {
        phone_number: string | null;
        is_blocked: boolean;
        is_personal: boolean;
        is_anonymized: boolean;
        consent: unknown;
      } | null;
    }>;
    for (const l of linhas) {
      const telefone = l.contacts?.phone_number ?? l.recipient_address;
      candidatos.push({
        id: l.id,
        telefone: (telefone ?? "").trim(),
        endereco: (telefone ?? "").trim(),
        valores: valoresCongelados(l.variables),
        motivo: motivoParaExcluir({
          contactId: l.contact_id,
          telefone,
          bloqueado: !!l.contacts?.is_blocked,
          pessoal: !!l.contacts?.is_personal,
          anonimizado: !!l.contacts?.is_anonymized,
          recusouMarketing: recusouMarketing(l.contacts?.consent),
        }),
      });
    }
    if (linhas.length < POR_PAGINA) break;
  }

  // A lista de exclusão da operação, revalidada AQUI e não só na preparação:
  // ela pode ter crescido depois do snapshot, e o ponto dela é impedir o envio.
  const semVeto = candidatos.filter((c) => c.motivo === null && c.endereco !== "");
  const suprimidos = new Set<string>();
  const hashes = [...new Set(semVeto.map((c) => hashDoEndereco(c.endereco)))];
  for (let i = 0; i < hashes.length; i += IDS_POR_FILTRO) {
    const { data, error } = await admin
      .from("campaign_suppressions")
      .select("recipient_address_hash")
      .eq("organization_id", campanha.organization_id)
      .in("recipient_address_hash", hashes.slice(i, i + IDS_POR_FILTRO));
    // Sem a lista, não se sabe quem pediu para não receber, e o que sai daqui sai
    // para todos de uma vez: a rodada cai e a seguinte confere de novo.
    if (error) throw new Error(`lista de exclusão da transmissão: ${error.message}`);
    for (const l of (data ?? []) as Array<{ recipient_address_hash: string }>) suprimidos.add(l.recipient_address_hash);
  }

  const porMotivo = new Map<string, string[]>();
  const prontos: Pronto[] = [];
  for (const c of candidatos) {
    const motivo = c.motivo ?? (suprimidos.has(hashDoEndereco(c.endereco)) ? "suprimido" : null);
    if (motivo === null) {
      prontos.push({ id: c.id, telefone: c.telefone, valores: c.valores });
      continue;
    }
    porMotivo.set(motivo, [...(porMotivo.get(motivo) ?? []), c.id]);
  }
  let pulados = 0;
  for (const [motivo, ids] of porMotivo) {
    for (let i = 0; i < ids.length; i += IDS_POR_FILTRO) {
      const { data } = await admin
        .from("campaign_recipients")
        .update({
          status: motivo === "suprimido" ? "skipped" : statusDaSaida(motivo as MotivoDeExclusao),
          eligibility_status: "excluded",
          exclusion_reason: motivo,
          opted_out_at: motivo === "opt_out" ? agora.toISOString() : null,
          sending_at: null,
        })
        .in("id", ids.slice(i, i + IDS_POR_FILTRO))
        .eq("status", status)
        .select("id");
      pulados += (data ?? []).length;
    }
  }
  return { prontos, pulados };
}

async function reservar(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  prontos: Pronto[],
  agora: Date,
): Promise<Pronto[]> {
  const reservadosIds = new Set<string>();
  for (let i = 0; i < prontos.length; i += IDS_POR_FILTRO) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .update({
        status: "sending",
        sending_at: agora.toISOString(),
        last_attempt_at: agora.toISOString(),
        attempt_count: 1,
        channel_session_id: campanha.channel_session_id,
      })
      .in(
        "id",
        prontos.slice(i, i + IDS_POR_FILTRO).map((p) => p.id),
      )
      .eq("status", "pending")
      .select("id");
    if (error) throw new Error(`reserva da transmissão: ${error.message}`);
    for (const l of (data ?? []) as Array<{ id: string }>) reservadosIds.add(l.id);
  }
  return prontos.filter((p) => reservadosIds.has(p.id));
}

async function statusDaCampanha(admin: SupabaseClient, campanhaId: string): Promise<string | null> {
  const { data } = await admin.from("campaigns").select("status").eq("id", campanhaId).maybeSingle();
  return (data as { status?: string } | null)?.status ?? null;
}

async function devolverAFila(admin: SupabaseClient, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += IDS_POR_FILTRO) {
    await admin
      .from("campaign_recipients")
      .update({ status: "pending", sending_at: null })
      .in("id", ids.slice(i, i + IDS_POR_FILTRO))
      .eq("status", "sending");
  }
}

/**
 * A janela da campanha E a do número, como na rodada de sempre, e o que o
 * número já mandou hoje — para o teto, que `tetoDaTransmissao` confere com o
 * tamanho da lista. A transmissão não espaça mensagens: o que ela respeita é
 * QUANDO sair e QUANTO cabe.
 */
async function janelaAberta(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  agora: Date,
): Promise<
  { aberta: true; limiteDoNumero: number | null; enviadosHoje: number; fuso: string } | { aberta: false; motivo: string }
> {
  const pool = getRequestPool();
  const k = await loadChannelKnobs(pool, campanha.organization_id, campanha.channel_session_id);
  const daCampanha = podeMandarAgora(
    {
      intervaloSegundos: null,
      janelaInicioHora: campanha.janela_inicio_hora,
      janelaFimHora: campanha.janela_fim_hora,
      tetoDiario: null,
      tetoHorario: null,
    },
    { ultimoEnvio: null, enviadasHoje: 0, enviadasNaUltimaHora: 0 },
    agora,
    k.knobs.timezone,
  );
  if (!daCampanha.pode) return { aberta: false, motivo: daCampanha.motivo };

  const { data: canal } = await admin
    .from("channel_sessions")
    .select("status, daily_message_limit")
    .eq("organization_id", campanha.organization_id)
    .eq("id", campanha.channel_session_id)
    .maybeSingle();
  const linha = canal as { status: string; daily_message_limit: number | null } | null;
  if (!linha || linha.status !== "WORKING") return { aberta: false, motivo: "canal_fora_do_ar" };

  const estado = await loadPacingState(pool, campanha.organization_id, campanha.channel_session_id, {
    now: agora,
    timezone: k.knobs.timezone,
    numberActivatedAt: k.numberActivatedAt,
  });
  const decisao = decidePacing({
    now: agora,
    knobs: k.knobs,
    state: estado,
    crmDailyLimit: linha.daily_message_limit ?? null,
    // A transmissão só existe no número oficial: daqui sai a JANELA. O teto do
    // dia não sai daqui porque este motor confere uma mensagem por vez — o
    // broadcast precisa do teto contra a LISTA inteira (`tetoDaTransmissao`).
    // O aquecimento e o espaçamento são do número por QR, como na rodada de
    // sempre (`canalTemRiscoDeBanimento`).
    banRisk: false,
  });
  if (!decisao.allow) return { aberta: false, motivo: `canal_${decisao.code}` };
  return {
    aberta: true,
    limiteDoNumero: linha.daily_message_limit ?? null,
    enviadosHoje: estado.sentToday,
    fuso: k.knobs.timezone,
  };
}

export const DETALHE_ACIMA_DO_TETO_DO_NUMERO =
  "A lista inteira não cabe no teto diário deste número (Conexões › Proteção de envio). O broadcast não manda em partes: ponha no teto o nível de mensagens que a plataforma deu ao número, ou troque a velocidade para Rápido, e retome a campanha.";
export const DETALHE_ACIMA_DO_TETO_DA_CAMPANHA =
  "A lista inteira, somada ao que esta campanha já mandou hoje e na última hora, passa do máximo por dia ou por hora dela, e o broadcast não manda em partes. Em «Ritmo desta campanha», salve com Broadcast para limpar o máximo ou troque a velocidade para Rápido, e retome a campanha.";
export const DETALHE_ENVIO_EM_VOO =
  "Ainda há mensagens saindo pela velocidade anterior desta campanha, e o broadcast mandaria de novo a essas pessoas. Aguarde um minuto e retome a campanha. Se o aviso voltar, troque a velocidade para Rápido e retome.";

/**
 * A lista inteira cabe no que o número e a campanha deixam mandar agora? Pura,
 * para o teste.
 *
 * Os tetos são os que o CRM tem e que o operador vê: o diário do número
 * (`channel_sessions.daily_message_limit`, em Conexões › Proteção de envio),
 * descontado o que o número já mandou hoje; e os máximos da campanha, quando
 * ela tem, descontado o que ela já mandou hoje e na última hora. O nível de mensagens que a plataforma dá ao número oficial não chega
 * por aqui — o teto diário do número é onde o operador o declara, e a tela do
 * broadcast diz isso.
 *
 * Não cabe = não sai: o broadcast não tem como mandar só uma parte, e mandar
 * acima do nível da plataforma é a enxurrada de recusas que derruba a
 * qualidade do número.
 */
export function tetoDaTransmissao(entrada: {
  tamanho: number;
  limiteDoNumero: number | null;
  enviadosHojeNoNumero: number;
  tetoDiarioDaCampanha: number | null;
  tetoHorarioDaCampanha: number | null;
  enviadasHojeNaCampanha: number;
  enviadasNaHoraNaCampanha: number;
}): { cabe: true } | { cabe: false; de: "numero" | "campanha"; livre: number } {
  if (entrada.limiteDoNumero !== null) {
    const livre = Math.max(0, entrada.limiteDoNumero - entrada.enviadosHojeNoNumero);
    if (entrada.tamanho > livre) return { cabe: false, de: "numero", livre };
  }
  const daCampanha = [
    entrada.tetoDiarioDaCampanha === null ? null : entrada.tetoDiarioDaCampanha - entrada.enviadasHojeNaCampanha,
    entrada.tetoHorarioDaCampanha === null ? null : entrada.tetoHorarioDaCampanha - entrada.enviadasNaHoraNaCampanha,
  ].filter((t): t is number => t !== null);
  if (daCampanha.length > 0) {
    const livre = Math.max(0, Math.min(...daCampanha));
    if (entrada.tamanho > livre) return { cabe: false, de: "campanha", livre };
  }
  return { cabe: true };
}

/** Os valores do modelo congelados em `variables.modelo`, ou `null` se não há. */
function valoresCongelados(variables: unknown): Record<string, string> | null {
  if (!variables || typeof variables !== "object") return null;
  const modelo = (variables as Record<string, unknown>).modelo;
  if (!modelo || typeof modelo !== "object" || Array.isArray(modelo)) return null;
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(modelo as Record<string, unknown>)) {
    if (typeof v === "string") saida[k] = v;
  }
  return saida;
}

/** Os mesmos valores, sem depender da ordem das chaves. */
function assinatura(valores: Record<string, string> | null): string {
  if (valores === null) return "null";
  return JSON.stringify(Object.keys(valores).sort().map((k) => [k, valores[k]]));
}

export async function modeloDaTransmissao(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  destinatarios: Pick<Pronto, "valores">[],
): Promise<{ ok: true; modelo: ModeloDaTransmissao } | { ok: false; codigo: string; detalhe: string }> {
  const name = campanha.provider_template_name?.trim() ?? "";
  const language = campanha.provider_template_language?.trim() ?? "";
  if (!name || !language) {
    return { ok: false, codigo: "modelo_inexistente", detalhe: "Escolha o modelo aprovado da campanha." };
  }
  const variaveis = variaveisDaCampanhaSchema.safeParse(campanha.provider_template_variables ?? {});
  const porPessoa = variaveis.success ? variaveisPorPessoa(variaveis.data) : [];
  if (!variaveis.success || porPessoa.length > 0) {
    return {
      ok: false,
      codigo: "transmissao_variavel",
      detalhe:
        "O broadcast manda o mesmo texto a todos, e este modelo usa dados de cada pessoa. " +
        "Troque a velocidade para Rápido e retome a campanha.",
    };
  }

  const valores = destinatarios[0]?.valores ?? {};
  const referencia = assinatura(destinatarios[0]?.valores ?? null);
  if (destinatarios.some((d) => assinatura(d.valores) !== referencia)) {
    return {
      ok: false,
      codigo: "transmissao_variavel",
      detalhe:
        "Os destinatários têm valores diferentes no modelo, e o broadcast manda o mesmo a todos. " +
        "Troque a velocidade para Rápido e retome a campanha.",
    };
  }

  const definicao = await definicaoDaCampanha(admin, {
    organizationId: campanha.organization_id,
    channelSessionId: campanha.channel_session_id,
    name,
    language,
  });
  if (!definicao) {
    return { ok: false, codigo: "modelo_inexistente", detalhe: "O modelo da campanha não existe mais neste número." };
  }
  const contrato = contratoDe(definicao);
  let components: ModeloDaTransmissao["components"] = [];
  try {
    if (contrato.slots.length > 0) components = buildComponents(contrato, valores);
  } catch (err) {
    return {
      ok: false,
      codigo: "modelo_sem_valores",
      detalhe: err instanceof Error ? err.message.slice(0, 300) : "Falta valor para uma variável do modelo.",
    };
  }
  const valoresDoCorpo = contrato.slots
    .filter((s) => s.address.kind === "body" && /^\d+$/.test(s.key))
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map((s) => valores[slotKey(s.address, s.key)] ?? "");
  return { ok: true, modelo: { name, language, components, valoresDoCorpo } };
}

// ─── 2. Acompanhar o relatório ──────────────────────────────────────────────

interface Nosso {
  id: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  message_id: string | null;
  rendered_body: string | null;
  telefone: string;
}

/** Status que nenhuma notícia do provedor muda: a pessoa já respondeu, saiu ou ficou de fora. */
const STATUS_ESTAVEIS = new Set(["replied", "opted_out", "cancelled", "skipped", "personal"]);
const ORDEM: Record<string, number> = { pending: 0, queued: 0, sending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * O que o relatório do provedor muda num destinatário — puro, para o teste.
 * Nunca rebaixa: o relatório é lido a cada rodada, e uma leitura atrasada não
 * pode tirar o "lido" que o eco já trouxe.
 */
export function desfechoDaTransmissao(
  atual: Pick<Nosso, "status" | "sent_at" | "delivered_at" | "read_at">,
  item: DestinatarioDaTransmissao | undefined,
): Record<string, string | null> | null {
  if (!item) return null;
  const patch: Record<string, string | null> = {};
  if (item.enviadoEm && !atual.sent_at) patch.sent_at = item.enviadoEm;
  if (item.entregueEm && !atual.delivered_at) patch.delivered_at = item.entregueEm;
  if (item.lidoEm && !atual.read_at) patch.read_at = item.lidoEm;

  if (!STATUS_ESTAVEIS.has(atual.status)) {
    if (item.status === "failed") {
      if (atual.status in ORDEM && atual.status !== "delivered" && atual.status !== "read") {
        patch.status = "failed";
        patch.last_error_code = item.codigoDoErro ?? "transmissao_falhou";
        patch.last_error_detail = item.erro;
        patch.sending_at = null;
      }
    } else if (item.status !== "pending" && atual.status !== "failed") {
      if ((ORDEM[item.status] ?? 0) > (ORDEM[atual.status] ?? 0)) patch.status = item.status;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function acompanhar(
  admin: SupabaseClient,
  campanha: CampanhaDaTransmissao,
  ops: OpsDeTransmissao,
  id: string,
  estado: EstadoDaTransmissao,
  agora: Date,
): Promise<ResultadoDaTransmissao> {
  const { mudancas, pendentesNoProvedor, completo, noRelatorio, primeiroEnvio } = await sincronizarTransmissao(
    admin,
    campanha,
    ops,
    id,
  );
  // A data do provedor, e não a desta rodada: ela não muda entre repetições, então
  // o que o expurgo do livro já levou volta velho, fora do teto de hoje.
  // ponytail: sem `enviadoEm` no relatório a data é a da rodada; só pesa com a
  // transmissão parada em `pending` além dos 2 dias do expurgo.
  await contarNoRitmoDoNumero(campanha, id, primeiroEnvio ?? agora, noRelatorio);
  if (!ESTADOS_FINAIS_DA_TRANSMISSAO.has(estado) || pendentesNoProvedor > 0) {
    return { ...SO_O_CONTADOR, detalhe: `transmissao:${estado}:${mudancas}` };
  }
  if (!completo) {
    // A leitura parou pelo teto de páginas com o provedor dizendo que havia
    // mais: quem não apareceu no pedaço lido NÃO é "sem registro". Fechar agora
    // marcaria como falha gente que o provedor entregou; a próxima rodada relê.
    logger.warn("[campanha] relatório da transmissão lido pela metade", { campanha: campanha.id, transmissao: id });
    return { ...SO_O_CONTADOR, detalhe: `transmissao:${estado}:${mudancas}:relatorio_incompleto` };
  }
  // O provedor terminou. Quem ainda está `sending` não está no relatório dele:
  // o número não tem WhatsApp, ou se repetia na lista — nunca vai sair.
  await fecharQuemFicou(admin, campanha.id, estado === "cancelled" ? "cancelled" : "failed", agora);
  if (estado !== "cancelled" && (await ninguemRecebeu(admin, campanha.id))) {
    await falhar(admin, campanha.id, agora, {
      codigo: "transmissao_tudo_falhou",
      detalhe:
        "A plataforma recusou o broadcast para todos os destinatários. Veja o motivo de cada pessoa na lista e confira o modelo e a qualidade do número antes de tentar de novo.",
    });
    return { ...SO_O_CONTADOR, detalhe: `transmissao:${estado}:${mudancas}:tudo_falhou` };
  }
  const concluidas = await concluirSeNadaEmVoo(admin, campanha.id, agora);
  return { ...SO_O_CONTADOR, concluidas, detalhe: `transmissao:${estado}:${mudancas}:concluida` };
}

/**
 * Ninguém recebeu e alguém falhou: a plataforma recusou todo mundo (teto,
 * qualidade, modelo pausado). Concluir isso como "Concluída" esconderia a única
 * notícia que o operador precisa ver sem abrir a lista.
 */
async function ninguemRecebeu(admin: SupabaseClient, campanhaId: string): Promise<boolean> {
  const { count: recebidos } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .in("status", ["sent", "delivered", "read", "replied", "opted_out"]);
  if ((recebidos ?? 0) > 0) return false;
  const { count: falhos } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .eq("status", "failed");
  return (falhos ?? 0) > 0;
}

/**
 * Lê o relatório inteiro e leva a cada destinatário o que mudou. Exportada para
 * o cancelamento, que precisa do último retrato antes de fechar a campanha.
 */
export async function sincronizarTransmissao(
  admin: SupabaseClient,
  campanha: Pick<CampanhaDaTransmissao, "id" | "organization_id">,
  ops: OpsDeTransmissao,
  id: string,
): Promise<{
  mudancas: number;
  pendentesNoProvedor: number;
  completo: boolean;
  noRelatorio: number;
  primeiroEnvio: Date | null;
}> {
  const nossos = await destinatariosEntregues(admin, campanha.id);
  const porTelefone = new Map<string, DestinatarioDaTransmissao>();
  let pular = 0;
  let completo = false;
  const teto = paginasDoRelatorio(nossos.length);
  for (let pagina = 0; pagina < teto; pagina++) {
    const p = await ops.destinatarios(id, { pular, quantos: POR_PAGINA_DO_PROVEDOR });
    for (const item of p.itens) porTelefone.set(item.telefone, item);
    if (!p.temMais || p.lidos === 0) {
      completo = true;
      break;
    }
    pular += p.lidos;
  }
  const pendentesNoProvedor = [...porTelefone.values()].filter((i) => i.status === "pending").length;

  let mudancas = 0;
  const semMensagem: Array<{ id: string; wamid: string; corpo: string | null }> = [];
  for (const n of nossos) {
    const item = porTelefone.get(digitosDoTelefone(n.telefone));
    const patch = desfechoDaTransmissao(n, item);
    if (patch) {
      const { data } = await admin
        .from("campaign_recipients")
        .update(patch)
        .eq("id", n.id)
        .eq("status", n.status)
        .select("id");
      mudancas += (data ?? []).length;
    }
    if (item?.idDaMensagem && !n.message_id) {
      semMensagem.push({ id: n.id, wamid: item.idDaMensagem, corpo: n.rendered_body });
    }
  }
  await ligarAsMensagens(admin, campanha.organization_id, semMensagem);
  let primeiroEnvio: Date | null = null;
  for (const { enviadoEm } of porTelefone.values()) {
    const em = enviadoEm ? new Date(enviadoEm) : null;
    if (em && !Number.isNaN(em.getTime()) && (!primeiroEnvio || em < primeiroEnvio)) primeiroEnvio = em;
  }
  return { mudancas, pendentesNoProvedor, completo, noRelatorio: porTelefone.size, primeiroEnvio };
}

/**
 * Quantas páginas do relatório ler: a lista inteira, mais folga para o que o
 * provedor guarda além dela (repetidos, quem a retomada repôs). Exportada para
 * o teste.
 */
export function paginasDoRelatorio(destinatarios: number): number {
  return Math.ceil(destinatarios / POR_PAGINA_DO_PROVEDOR) + 10;
}

async function destinatariosEntregues(admin: SupabaseClient, campanhaId: string): Promise<Nosso[]> {
  const nossos: Nosso[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, status, sent_at, delivered_at, read_at, message_id, rendered_body, recipient_address, contacts(phone_number)",
      )
      .eq("campaign_id", campanhaId)
      .in("status", ["pending", "queued", "sending", "sent", "delivered", "read", "failed"])
      .order("id", { ascending: true })
      .range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
    if (error) throw new Error(`destinatários da transmissão: ${error.message}`);
    const linhas = (data ?? []) as unknown as Array<
      Omit<Nosso, "telefone"> & { recipient_address: string | null; contacts: { phone_number: string | null } | null }
    >;
    for (const l of linhas) {
      nossos.push({
        id: l.id,
        status: l.status,
        sent_at: l.sent_at,
        delivered_at: l.delivered_at,
        read_at: l.read_at,
        message_id: l.message_id,
        rendered_body: l.rendered_body,
        telefone: l.contacts?.phone_number ?? l.recipient_address ?? "",
      });
    }
    if (linhas.length < POR_PAGINA) break;
  }
  return nossos;
}

/**
 * O destinatário aponta para a linha da conversa quando o eco já chegou e a
 * ingestão não conseguiu ligar (o contato resolvido não era o da lista, por
 * exemplo). Com a ligação, entrega e leitura passam a vir também pelo gatilho de
 * ack — e a linha que nasceu com "[Template: nome]" ganha o texto que a pessoa
 * leu, que é o que o agente precisa quando ela responder.
 */
async function ligarAsMensagens(
  admin: SupabaseClient,
  organizationId: string,
  pares: Array<{ id: string; wamid: string; corpo: string | null }>,
): Promise<void> {
  for (let i = 0; i < pares.length; i += IDS_POR_FILTRO) {
    const lote = pares.slice(i, i + IDS_POR_FILTRO);
    const { data } = await admin
      .from("messages")
      .select("id, external_id, conversation_id")
      .eq("organization_id", organizationId)
      .in(
        "external_id",
        lote.map((p) => p.wamid),
      );
    const porWamid = new Map(
      ((data ?? []) as Array<{ id: string; external_id: string; conversation_id: string }>).map((m) => [m.external_id, m]),
    );
    for (const p of lote) {
      const m = porWamid.get(p.wamid);
      if (!m) continue;
      await admin
        .from("campaign_recipients")
        .update({ message_id: m.id, conversation_id: m.conversation_id })
        .eq("id", p.id)
        .is("message_id", null);
      if (p.corpo) {
        await admin
          .from("messages")
          .update({ body: p.corpo })
          .eq("organization_id", organizationId)
          .eq("id", m.id)
          .like("body", "[Template:%");
      }
    }
  }
}

async function fecharQuemFicou(
  admin: SupabaseClient,
  campanhaId: string,
  como: "failed" | "cancelled",
  agora: Date,
): Promise<number> {
  const { data } = await admin
    .from("campaign_recipients")
    .update(
      como === "cancelled"
        ? { status: "cancelled", cancelled_at: agora.toISOString(), sending_at: null }
        : {
            status: "failed",
            sending_at: null,
            last_error_code: "transmissao_sem_registro",
            last_error_detail:
              "O provedor não registrou este destinatário: o número não tem WhatsApp ou estava repetido na lista.",
          },
    )
    .eq("campaign_id", campanhaId)
    .in("status", ["pending", "queued", "sending"])
    .select("id");
  return (data ?? []).length;
}

async function concluirSeNadaEmVoo(admin: SupabaseClient, campanhaId: string, agora: Date): Promise<number> {
  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campanhaId)
    .in("status", ["pending", "queued", "sending"]);
  if ((count ?? 0) > 0) return 0;
  const { data } = await admin
    .from("campaigns")
    .update({ status: "completed", completed_at: agora.toISOString() })
    .eq("id", campanhaId)
    .eq("status", "running")
    .select("id");
  return (data ?? []).length;
}

async function falhar(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  falha: { codigo: string; detalhe: string },
): Promise<void> {
  await admin
    .from("campaigns")
    .update({ status: "failed", failed_at: agora.toISOString(), failure_code: falha.codigo, failure_detail: falha.detalhe })
    .eq("id", campanhaId)
    .eq("status", "running");
}

async function pausar(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  falha: { codigo: string; detalhe: string },
): Promise<void> {
  await admin
    .from("campaigns")
    .update({ status: "paused", paused_at: agora.toISOString(), failure_code: falha.codigo, failure_detail: falha.detalhe })
    .eq("id", campanhaId)
    .eq("status", "running");
}

// ─── 3. O cancelamento ──────────────────────────────────────────────────────

export const DETALHE_CANCELAMENTO_RECUSADO =
  "Cancelada no CRM, mas o provedor recusou o cancelamento do broadcast, e o envio pode continuar. Confira no painel de broadcasts dele se o envio parou e apague o rascunho, se ele ainda estiver lá.";
export const DETALHE_CANCELAMENTO_SEM_CONEXAO =
  "Cancelada no CRM, mas este número não fala mais com o provedor do broadcast, e o envio pode continuar. Confira no painel de broadcasts dele se o envio parou e apague o rascunho, se ele ainda estiver lá.";
export const DETALHE_ENVIO_PODE_CONTINUAR =
  "Cancelada no CRM, mas o provedor não confirmou que o broadcast parou, e o envio pode continuar. Confira no painel de broadcasts dele se o envio parou e apague o rascunho, se ele ainda estiver lá.";
export const DETALHE_RASCUNHO_NAO_APAGADO =
  "Cancelada no CRM, mas o rascunho do broadcast pode ter ficado no provedor, com a lista. Confira no painel de broadcasts dele e apague-o.";

/** A campanha cancelada ganha UMA frase em «Último problema»: cada uma já diz tudo o que o operador tem a conferir. */
async function avisarDoCancelamento(
  admin: SupabaseClient,
  campanhaId: string,
  id: string,
  aviso: { codigo: string; detalhe: string; motivo: string },
): Promise<void> {
  logger.warn("[campanha] parada da transmissão cancelada não confirmada", {
    campanha: campanhaId,
    transmissao: id,
    codigo: aviso.codigo,
    motivo: aviso.motivo,
  });
  await admin.from("campaigns").update({ failure_code: aviso.codigo, failure_detail: aviso.detalhe }).eq("id", campanhaId);
}

/** O estado no provedor, ou `null` se não deu para ler: quem não leu não sabe que parou. */
async function estadoLido(ops: OpsDeTransmissao, campanhaId: string, id: string): Promise<EstadoDaTransmissao | null> {
  try {
    return (await ops.ler(id)).estado;
  } catch (err) {
    logger.warn("[campanha] estado da transmissão cancelada não lido", {
      campanha: campanhaId,
      transmissao: id,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const ehFinal = (estado: EstadoDaTransmissao | null): boolean =>
  estado !== null && ESTADOS_FINAIS_DA_TRANSMISSAO.has(estado);

/**
 * Faz o provedor parar, e só dá por parado o que ele diz que terminou. Rascunho
 * é apagado, porque `cancelar` não o alcança e a lista ficaria lá, pronta para
 * sair por um clique no painel dele. O resto é cancelado e relido: o `cancelar`
 * também responde em silêncio a um 400, então a resposta dele não prova nada. Sem
 * confirmação, quem cancelou precisa saber, porque acha que parou.
 */
async function pararNoProvedor(
  admin: SupabaseClient,
  ops: OpsDeTransmissao,
  campanhaId: string,
  id: string,
): Promise<{ apagado: boolean }> {
  const antes = await estadoLido(ops, campanhaId, id);
  if (ehFinal(antes)) return { apagado: false };
  if (antes === "draft") {
    try {
      if (await ops.descartar(id)) return { apagado: true };
    } catch (err) {
      await avisarDoCancelamento(admin, campanhaId, id, {
        codigo: "transmissao_rascunho_nao_apagado",
        detalhe: DETALHE_RASCUNHO_NAO_APAGADO,
        motivo: err instanceof Error ? err.message : String(err),
      });
      return { apagado: false };
    }
  }
  try {
    await ops.cancelar(id);
  } catch (err) {
    await avisarDoCancelamento(admin, campanhaId, id, {
      codigo: "transmissao_cancelamento_recusado",
      detalhe: DETALHE_CANCELAMENTO_RECUSADO,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return { apagado: false };
  }
  const depois = await estadoLido(ops, campanhaId, id);
  if (!ehFinal(depois)) {
    await avisarDoCancelamento(admin, campanhaId, id, {
      codigo: "transmissao_envio_pode_continuar",
      detalhe: DETALHE_ENVIO_PODE_CONTINUAR,
      motivo: `estado depois do cancelamento: ${depois ?? "não lido"}`,
    });
  }
  return { apagado: false };
}

/**
 * Cancelar a campanha para o que o provedor ainda não mandou
 * (`pararNoProvedor`), traz o último retrato do relatório e fecha quem ficou.
 * Devolve quantos destinatários fechou — numa transmissão todos estão `sending`,
 * e é aqui que o cancelamento os alcança.
 *
 * A campanha já está cancelada no CRM quando isto roda, e uma falha do provedor
 * não a desfaz. Mas ela não pode dizer só "cancelada" enquanto o provedor segue
 * entregando: quando o provedor recusa, não confirma a parada (ou o número não
 * fala mais com ele), a campanha ganha a frase em «Último problema», para o
 * operador conferir no painel dele. Quem ficou `sending` é fechado nos dois
 * caminhos — antes, a conexão trocada deixava as linhas em `sending` para sempre.
 */
export async function encerrarTransmissao(
  admin: SupabaseClient,
  campanha: { id: string; organization_id: string; channel_session_id: string; provider_broadcast_id: string | null },
  agora: Date,
): Promise<number> {
  // Sem id, nada foi entregue ao provedor — e a reserva (`sending`) só nasce
  // depois do id. Fechar `sending` aqui alcançaria a campanha de sempre, onde
  // `sending` é mensagem que pode estar saindo neste instante.
  const id = campanha.provider_broadcast_id;
  if (!id) return 0;
  const ops = await transmissaoDaConexao(admin, {
    organizationId: campanha.organization_id,
    channelSessionId: campanha.channel_session_id,
  }).catch(() => null);
  if (!ops) {
    await avisarDoCancelamento(admin, campanha.id, id, {
      codigo: "transmissao_cancelamento_recusado",
      detalhe: DETALHE_CANCELAMENTO_SEM_CONEXAO,
      motivo: "sem conexão com o provedor",
    });
    return fecharQuemFicou(admin, campanha.id, "cancelled", agora);
  }
  const { apagado } = await pararNoProvedor(admin, ops, campanha.id, id);
  // Rascunho apagado não tem relatório: nada saiu. O último retrato é melhor
  // esforço: sem ele, fecha-se igual.
  if (!apagado) {
    await sincronizarTransmissao(admin, campanha, ops, id).catch((err: unknown) => {
      logger.warn("[campanha] relatório da transmissão cancelada não lido", {
        campanha: campanha.id,
        motivo: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return fecharQuemFicou(admin, campanha.id, "cancelled", agora);
}

// ─── 4. O eco de cada mensagem ──────────────────────────────────────────────

export interface EcoDaTransmissao {
  campanhaId: string;
  destinatarioId: string;
  /** O texto do modelo congelado no destinatário — o que a pessoa recebeu. */
  corpo: string | null;
  modelo: string | null;
  idioma: string | null;
  versaoDoConteudo: number;
  transmissaoId: string;
}

/**
 * A campanha e o destinatário de uma mensagem que o provedor mandou por uma
 * transmissão — ou `null` quando a transmissão não é de campanha nenhuma (criada
 * no painel do provedor, por exemplo).
 */
export async function ecoDaTransmissao(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    transmissaoId: string;
    contactId: string;
    /** O telefone do outro lado, em E.164 — para quando o contato resolvido não é o da lista. */
    telefone?: string | null;
  },
): Promise<EcoDaTransmissao | null> {
  const { data: campanha } = await admin
    .from("campaigns")
    .select("id, content_version, provider_template_name, provider_template_language")
    .eq("organization_id", entrada.organizationId)
    .eq("provider_broadcast_id", entrada.transmissaoId)
    .maybeSingle();
  if (!campanha) return null;
  const c = campanha as {
    id: string;
    content_version: number;
    provider_template_name: string | null;
    provider_template_language: string | null;
  };
  const porContato = await admin
    .from("campaign_recipients")
    .select("id, rendered_body")
    .eq("campaign_id", c.id)
    .eq("contact_id", entrada.contactId)
    .limit(1)
    .maybeSingle();
  // O contato que a ingestão resolveu pode não ser o da lista (o mesmo número
  // gravado de outro jeito): o telefone para que a pessoa foi é a outra chave.
  const destinatario =
    porContato.data ??
    (entrada.telefone
      ? (
          await admin
            .from("campaign_recipients")
            .select("id, rendered_body")
            .eq("campaign_id", c.id)
            .eq("recipient_address", entrada.telefone)
            .limit(1)
            .maybeSingle()
        ).data
      : null);
  if (!destinatario) return null;
  const d = destinatario as { id: string; rendered_body: string | null };
  return {
    campanhaId: c.id,
    destinatarioId: d.id,
    corpo: d.rendered_body,
    modelo: c.provider_template_name,
    idioma: c.provider_template_language,
    versaoDoConteudo: c.content_version,
    transmissaoId: entrada.transmissaoId,
  };
}

/** Liga o destinatário à linha do eco: dali em diante o ack chega pelo gatilho. */
export async function ligarEcoAoDestinatario(
  admin: SupabaseClient,
  eco: EcoDaTransmissao,
  mensagem: { id: string; conversationId: string; enviadaEm: string | null },
): Promise<void> {
  await admin
    .from("campaign_recipients")
    .update({ message_id: mensagem.id, conversation_id: mensagem.conversationId })
    .eq("id", eco.destinatarioId)
    .is("message_id", null);
  await admin
    .from("campaign_recipients")
    .update({ status: "sent", sent_at: mensagem.enviadaEm ?? new Date().toISOString() })
    .eq("id", eco.destinatarioId)
    .in("status", ["pending", "queued", "sending"]);
}

/** Os metadados da linha do eco — os mesmos que o envio de campanha grava. */
export function metadataDoEco(eco: EcoDaTransmissao): Record<string, unknown> {
  return {
    source: "campaign",
    campaign_id: eco.campanhaId,
    campaign_recipient_id: eco.destinatarioId,
    campaign_content_version: eco.versaoDoConteudo,
    provider_broadcast_id: eco.transmissaoId,
  };
}
