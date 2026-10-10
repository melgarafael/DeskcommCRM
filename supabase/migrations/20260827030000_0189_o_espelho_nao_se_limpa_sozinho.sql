-- ============================================================================
-- 0189 — A PODA POR PRAZO NÃO FECHA O FANTASMA, E QUEM LER VAI PRESUMIR QUE SIM
--
-- A 0187 deu prazo ao espelho da agenda e o `comment on table` passou a dizer
-- que ele é "cache com prazo". Está certo e é insuficiente: quem ler aquela
-- frase vai concluir que o espelho se limpa sozinho, e não se limpa.
--
-- O caso que a poda NÃO alcança: um evento com `ends_at` no FUTURO, de uma
-- conexão VIVA, que foi apagado no Google. Ele nunca envelhece — o corte é por
-- `ends_at < now() - N dias`, e `ends_at` no futuro não vence nunca. Fica no
-- espelho para sempre, ocupando um horário que na agenda do cliente já está
-- livre. O sintoma é o oposto do que a poda protege: em vez de dado velho
-- demais, é dado que deveria ter sumido e não some, e ele faz a agenda RECUSAR
-- um horário que existe.
--
-- Quem limpa isso é a RECONCILIAÇÃO do sync: ao trazer a janela do Google,
-- remover o que não veio na resposta. Isso é da frente do Google e não existe
-- hoje. Não é defeito desta migration — é o limite dela, e o limite precisa
-- estar escrito onde a promessa está, senão a promessa engana.
--
-- ⚠️ Por que isto merece uma migration em vez de uma linha de doc: o
-- `comment on table` é o que um DBA lê no `\d+`, e é a única declaração que
-- viaja junto com o schema para todo clone. Uma ressalva que fica só no
-- briefing morre com a entrega.
--
-- Aditiva: só reescreve um comentário. Nenhuma linha de dado é tocada.
-- ============================================================================

comment on table public.calendar_external_events is
  'ESPELHO, somente-leitura, do que já existe na agenda conectada. Ocupa horário e aparece na grade, mas NÃO é compromisso nosso: não tem lead, não tem estado de atendimento e nunca é reescrito por nós. '
  'É CACHE — reconstruível pelo sync, apagado em cascata quando a conexão sai, e com prazo para o PASSADO (fn_expurgar_espelho_da_agenda, migration 0187). '
  '⚠️ O PRAZO NÃO LIMPA O FANTASMA: evento com ends_at no FUTURO, de conexão viva, apagado lá no Google, nunca envelhece e fica aqui para sempre — ocupando um horário que na agenda do cliente já está livre, e fazendo a agenda RECUSAR hora que existe. Quem limpa isso é a RECONCILIAÇÃO do sync (remover o que não veio na resposta da janela), que é da frente do Google e não existe hoje. '
  'Fica FORA da cascata de LGPD por não ter contact_id: o único vínculo com a pessoa é o title copiado do Google, e a fonte da verdade daquele dado é a agenda do próprio cliente, onde o titular exerce o direito com o controlador de lá. A mira de verdade só nasce com o escritor do sync, que terá o ical_uid para ligar — decisão de QUANDO, não de SE.';

notify pgrst, 'reload schema';
