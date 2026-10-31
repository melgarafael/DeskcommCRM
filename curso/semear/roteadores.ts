/**
 * Semente do módulo "Roteadores" (Agente de IA › Ver tudo em IA › Roteadores,
 * /app/ai/routers): o roteador que a Clínica Bem Viver está montando para o
 * número da recepção, ainda DESLIGADO e sem intenções gravadas — o estado de
 * quem acabou de criar e vai configurar antes de ligar.
 *
 * Por que sem intenções gravadas: uma intenção aponta para um agente, e a base
 * só tem a Bia. Uma linha em `ai_router_members` com a Bia faz o editor DELA
 * (tela Agentes) mostrar "Este agente é acionado pelo roteador…", e a foto das
 * outras aulas mudaria. Criar agentes especialistas aqui seria pior: a aula de
 * Agentes diz que a clínica tem um só, e a base escolhe "o" agente sem ordem.
 * As lições preenchem a intenção na tela e NÃO salvam (o `clicar` não executa).
 *
 * Por que desligado: um roteador ativo muda o que outras telas leem (Aviso no
 * WhatsApp, Jev). Desligado e sem intenções, ele não muda nada fora daqui.
 *
 * Idempotente: `limpar` apaga só as próprias linhas (id fixo d1130000-… e os
 * roteadores que as lições criam pela tela, pelo nome) e `semear` recria. A base
 * chama `limpar` antes de QUALQUER aula, então nada desta semente sobra na foto
 * de outro módulo (nem o roteador ATIVO que a lição "Criar um roteador" cria).
 */
import { textoDaDemonstracao as demo, traducaoDaDemonstracao } from "../espanhol-demonstracao";
import { type Contexto, semErro } from "../semear-demonstracao";

const ROTEADOR = "d1130000-0000-4000-8000-000000000001";

/** Nomes que as lições criam pela tela: apagados aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Triagem do WhatsApp"];

export async function limpar(c: Contexto) {
  const { db, org } = c;
  // apagar o roteador leva junto, por cascata, as intenções (ai_router_members)
  semErro(await db.from("ai_routers").delete().eq("organization_id", org).eq("id", ROTEADOR), "limpar roteador");
  semErro(
    await db
      .from("ai_routers")
      .delete()
      .eq("organization_id", org)
      // os dois idiomas, sem `demo()`: a base chama `limpar` antes de toda aula, e
      // um `demo()` sem tradução no catálogo lançaria e derrubaria a aula de outro módulo
      .in("name", CRIADAS_NAS_LICOES.flatMap((n) => [n, traducaoDaDemonstracao(n) ?? n])),
    "limpar roteadores das lições",
  );
}

export async function semear(c: Contexto) {
  const { db, org, sessao, agenteId } = c;
  await limpar(c);

  semErro(
    await db.from("ai_routers").insert({
      id: ROTEADOR,
      organization_id: org,
      name: demo("Triagem da recepção"),
      channel_session_id: sessao,
      is_active: false,
      // a Bia atende o que nenhuma intenção pegar
      fallback_agent_id: agenteId,
      // A tela grava só context_message_count (NEW_ROUTER_CONTEXT_MESSAGES = 8) e
      // deixa o classificador em "Automático"; sticky e min_confidence são os
      // valores que o runtime assume quando faltam (router-config.ts), aqui explícitos.
      config: { sticky: true, min_confidence: 0.6, context_message_count: 8 },
      created_by: c.pessoa.helena,
    }),
    "roteador da recepção",
  );
}
