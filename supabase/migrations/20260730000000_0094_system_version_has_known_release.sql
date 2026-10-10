-- 0094 — distingue "à frente da publicada" de "nunca houve versão publicada".
--
-- Achado na revisão final da branch de atualização pela UI: num fork sem
-- nenhuma tag `v*` (repositório completo, `origin` alcançável), o agente
-- reporta off_release=true + latest_version="" + compare_failed=false — a
-- MESMA combinação que uma instalação que já contém a última tag publicada
-- (retrocesso recusado, ver migration 0089/agent.sh). A tela não tinha como
-- diferenciar as duas e afirmava "você está à frente da versão publicada"
-- sem nenhuma versão publicada existir — a frase tranquilizadora sem base que
-- o princípio do produto proíbe (falhar fechado na ação, nunca na informação).
--
-- Uma coluna, não um estado novo: `true` quando o agente já viu ao menos uma
-- tag `v*` no repositório (mesmo que ela tenha sido descartada depois por já
-- estar contida no HEAD ou por dúvida de comparação).
alter table public.system_version
  add column if not exists has_known_release boolean not null default true;

comment on column public.system_version.has_known_release is
  'false quando o agente do host nunca viu nenhuma tag v* no repositório (fork sem releases). Default true preserva o comportamento anterior para agentes antigos que ainda não enviam este campo.';
