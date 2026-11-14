---
impacto: capacidade_nova
secao: corrigido
titulo: Skill em .zip do ecossistema (SKILL.md sem matcher) importa e pode ser usada pelo roteiro
---

O envio de skill em `.zip` recusava qualquer `SKILL.md` sem `matcher`, com a
mensagem "O matcher do SKILL.md precisa de any_keywords". O formato é legítimo: a
maioria das skills publicadas fora do CRM — a `humanizer` de `blader/humanizer` é o
caso do relato — declara só `name` e `description`. Agora a skill importa com o
matcher vazio e fica declarado o que isso significa: ela **não** entra sozinha na
conversa por palavra-chave nem por etiqueta; o corpo dela só é injetado quando o
roteiro de atendimento a puxa **pelo nome** (nó `skill`). O editor mostra esse
recado no campo de palavras-chave, e a própria tela permite salvar a skill sem
inventar palavra nenhuma. Matcher realmente inválido continua recusado, agora com o
**campo** no nome do erro (`any_keywords`, `probe_keywords` ou `any_tags`); chave
desconhecida dentro do `matcher` (typo) também vira erro em vez de "skill sem
matcher". `description: |` (bloco multilinha) passa a virar uma descrição só, em vez
do literal `|`. Skill que já tinha matcher continua idêntica. Sem migration: a coluna
`skill_versions.matcher` é `jsonb not null default '{}'`. Contribuição de
@webtecnica (#4458).
