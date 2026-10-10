-- ═══════════════════════════════════════════════════════════════════════════
-- 0439 — O aviso de caso confere, NA HORA DE ENVIAR, se o destino voltou a ser
--        um número da própria organização.
--
-- ─── O que não existia ────────────────────────────────────────────────────
--
-- A 0292 fechou o laço robô-com-robô do aviso de caso recusando como destino um
-- número de conexão DA PRÓPRIA ORGANIZAÇÃO. Essa pergunta só é feita quando
-- alguém DEFINE o aviso (`fn_definir_aviso_de_caso`).
--
-- A 0438 tirou do caminho a conexão ARQUIVADA — que não envia e não recebe, e
-- portanto não fechava laço nenhum —, e era o conserto certo para o número que
-- ficava bloqueado para sempre (a conexão que já teve agente publicado não pode
-- ser apagada). Só que arquivar não APAGA a linha: reativar é gravar
-- `archived_at = null` de novo. Se o número daquela conexão ficou gravado como
-- destino do aviso, nenhuma checagem volta a rodar — e o aviso passa a sair para
-- um número atendido por um agente DESTA organização. O laço que a 0292 evita
-- reabre pela porta que a 0438 abriu.
--
-- ─── A correção ───────────────────────────────────────────────────────────
--
-- Este arquivo NÃO muda o motor: ele acrescenta ao vocabulário FECHADO
-- `entregas_de_aviso_de_caso.erro_codigo` o código com que a recusa fica
-- registrada. A guarda em si mora em `lib/escalacao/aviso-ao-suporte.ts`, no
-- passo do destino, e ela CONDEMA a entrega com este código em vez de enviar —
-- o que grava a linha em `entregas_de_aviso_de_caso`, abre o item na Central
-- (`agent_inbox_items`, kind `aviso_de_caso_nao_entregue`) e audita
-- `ai.case_alert_failed`, exatamente como as outras recusas definitivas.
--
-- Por que a checagem fica no ENVIO e não na reativação: a linha é ressuscitada
-- por caminhos diferentes (reconectar o canal oficial, retomar o pareamento pelo
-- onboarding, o `finish` da conexão do WAHA) e uma guarda em cada um deles
-- nasceria desatualizada no dia em que aparecesse o quarto. No envio há um lugar
-- só, e ele enxerga todos. É a mesma escolha de desenho que a 0438 documenta ao
-- editar o bloco no lugar: o mecanismo vale mais que a disciplina de lembrar.
--
-- Sem tabela, sem coluna, sem policy, sem dado tocado: só o CHECK de um
-- vocabulário que já existia.
--
-- ─── Por que o CHECK muda ─────────────────────────────────────────────────
--
-- `erro_codigo` tem CHECK de conjunto fechado (0292). Um código novo sem a
-- constraint correspondente seria `23514` no UPDATE que o próprio motor faz
-- depois de decidir a recusa — e a entrega ficaria `pendente` sem diagnóstico.
-- O bloco da 0292 é reconstruído UMA vez, com o vocabulário de hoje, pelo padrão
-- que `baseline-constraint-reconstruida` documenta.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_erro_codigo_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_erro_codigo_check
  check (erro_codigo is null or erro_codigo in (
    'canal_desconectado',
    'canal_arquivado',
    'canal_nao_aceita_aviso_livre',
    'transporte_ausente',
    'destino_invalido',
    'teto_diario_do_numero',
    'sem_endereco_publico',
    'titular_anonimizado',
    'expirou',
    'falha_no_envio',
    'indeterminado',
    -- (0439) O número de destino voltou a ser de uma conexão ATIVA desta
    -- organização — o laço robô-com-robô que a 0292 recusa ao definir o aviso.
    'destino_da_propria_organizacao'));
