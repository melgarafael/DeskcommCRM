-- ============================================================================
-- 0182 — ENTRE A VALIDAÇÃO E O INSERT HÁ UMA JANELA, E DOIS POSTS CABEM NELA
--
-- O motor de slots decide se o horário está livre ANTES de gravar. Entre aquela
-- pergunta e o INSERT existe um intervalo em que o banco não repete a pergunta
-- — então dois POSTs simultâneos para o mesmo horário passam OS DOIS na
-- checagem e criam dois agendamentos. É o duplo clique da recepcionista, e é a
-- corrida entre duas pessoas marcando o mesmo slot ao mesmo tempo.
--
-- O acidental é justamente o que o motor NÃO vê: ele validou, e estava certo
-- quando validou.
--
-- ─── Por que ISTO e não a constraint de sobreposição ──────────────────────
-- A 0177 recusou `exclude using gist (owner_user_id with =, tstzrange(...) &&)`
-- por duas razões que continuam valendo, e esta migration não as contradiz:
--   1. exigiria `btree_gist`, medido ausente no baseline (que só cria
--      `pgcrypto`) e no prelude de `scripts/test-db.sh` — quebraria o `install`
--      de todo clone;
--   2. proibiria SOBREPOSIÇÃO — 14h-15h contra 14h30-15h30 —, que é o encaixe
--      que uma recepção faz todo dia.
-- Um índice único parcial é outra coisa: é btree PURO, e proíbe só a
-- COINCIDÊNCIA EXATA de instante para o MESMO dono. Nunca alcança 14h30 contra
-- 14h. A distinção é do @DevVivo e ela é o que faz esta passar onde aquela não
-- passava.
--
-- ─── `owner_user_id is not null`: o que ela faz, e o que NÃO faz ─────────
-- ⚠️ Eu apresentei esta condição como conserto de um buraco, e ela NÃO é. Medi
-- num pg17 descartável, os dois índices lado a lado com dono NULL e mesmo
-- instante:
--
--     sem a condição -> 2 linhas entram
--     com a condição -> 2 linhas entram      (idêntico)
--     controle, com dono real -> a segunda é recusada (23505)
--
-- A razão é que `NULL` nunca colide com `NULL` numa UNIQUE, esteja a linha
-- DENTRO ou FORA do índice. Tirar a condição não abriria buraco nenhum: as
-- linhas sem dono já não colidem entre si de qualquer forma.
--
-- O que a condição faz de verdade, e por isso ela fica: (1) mantém fora do
-- índice as linhas que nunca vão colidir, e (2) DECLARA o alcance da guarda —
-- ela é sobre a agenda de uma PESSOA, e agendamento sem atendente não ocupa a
-- agenda de ninguém. É documentação executável, não proteção.
--
-- Escrito assim porque a versão anterior deste comentário afirmava uma proteção
-- inexistente, e comentário que promete guarda que não existe é pior que
-- comentário nenhum: quem lê para de procurar.
--
-- ─── O que esta constraint CUSTA, escrito para ninguém descobrir sozinho ──
-- Ela proíbe dois compromissos do MESMO atendente no MESMO instante — e numa
-- clínica isso às vezes É o encaixe: a recepção põe dois pacientes às 14h de
-- propósito, sabendo que um vai esperar.
--
-- A troca é deliberada: uma corrida silenciosa vale mais que um caso legítimo
-- raro. Mas o 23505 NÃO pode virar um erro genérico na tela. A rota captura e
-- devolve 409 dizendo QUAL compromisso está ali e oferecendo o caminho
-- (remarcar, ou marcar no minuto seguinte). É o invariante 4 do Sistema Vivo —
-- nenhuma demanda sem próximo passo. Sem isso, trocamos uma corrida rara por
-- uma parede diária, e "o sistema não me deixa marcar" é a frase que faz PME
-- desinstalar.
--
-- ─── Deduplicar ANTES da constraint (a doutrina, e ela morde de verdade) ──
-- Índice único falha se os dados já o violam, e num clone isso quebraria o
-- `update.sh` — que roda SEM `ON_ERROR_STOP` e filtra erro por texto, então o
-- operador veria o alarme errado.
--
-- Hoje nenhum clone tem linha nesta tabela: ela nasceu na 0177, hoje, e a rota
-- que grava ainda não existe. O bloco abaixo é para o clone que vier a ter, e
-- ele NÃO decide qual compromisso vale — deslocar é a única correção que não
-- destrói informação. Cancelar a duplicata apagaria um compromisso combinado
-- com uma pessoa real, e isso uma migration não faz.
-- ============================================================================

-- ─── 1 · deduplicar deslocando, sem perder nenhum compromisso ──────────────
-- Empurra a 2ª, 3ª… ocorrência em 1 segundo cada, levando `ends_at` junto para
-- a duração não mudar. Em laço porque um deslocamento pode cair em cima de
-- outro instante já ocupado; 10 passadas cobrem qualquer caso real e o teto
-- impede laço infinito num dado patológico.
do $$
declare
  mexidas integer;
  passada integer := 0;
begin
  loop
    with duplicadas as (
      select id,
             row_number() over (
               partition by organization_id, owner_user_id, starts_at
               order by created_at, id
             ) - 1 as posicao
        from public.calendar_appointments
       where status in ('pending', 'confirmed')
         and owner_user_id is not null
    )
    update public.calendar_appointments a
       set starts_at = a.starts_at + (d.posicao * interval '1 second'),
           ends_at   = a.ends_at   + (d.posicao * interval '1 second')
      from duplicadas d
     where d.id = a.id
       and d.posicao > 0;

    get diagnostics mexidas = row_count;
    passada := passada + 1;
    exit when mexidas = 0 or passada >= 10;
  end loop;
end
$$;

-- ─── 2 · a guarda ─────────────────────────────────────────────────────────
create unique index if not exists calendar_appointments_sem_duplicata_idx
  on public.calendar_appointments (organization_id, owner_user_id, starts_at)
  where status in ('pending', 'confirmed') and owner_user_id is not null;

comment on index public.calendar_appointments_sem_duplicata_idx is
  'Fecha a janela entre a validação do motor de slots e o INSERT: dois POSTs simultâneos para o mesmo instante e o mesmo atendente não viram dois compromissos. Parcial em (pending, confirmed) porque cancelado e realizado não ocupam ninguém, e em owner_user_id não nulo porque NULL não colide com NULL numa UNIQUE — e porque agendamento sem atendente não ocupa agenda. Quem captura o 23505 é a rota, que devolve 409 dizendo qual compromisso está ali.';

notify pgrst, 'reload schema';
