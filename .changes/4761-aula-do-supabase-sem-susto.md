---
impacto: nada_mudou
secao: adicionado
titulo: O curso ganha uma aula sobre as cotas do Supabase, como medir e a região do projeto
---

O curso ilustrado não tinha nenhuma aula sobre cota, custo e compute do Supabase — a dúvida que mais volta na comunidade: quem bate no limite do plano grátis, quem vê o CRM parado no Nano e quem recebe o aviso "Log Ingestion Exceeded". A aula nova entra no módulo "Recursos opcionais (Admin)" e ensina os cinco tetos do plano grátis — 500 MB de banco, 1 GB de storage, 50 mil usuários ativos no mês, 5 GB por mês de egress e 1 GB de log ingerido por ciclo —, o sintoma de cada um, como medir no painel do Supabase antes de pagar, a conta do compute Nano contra o Micro, a escolha da região perto da VPS e as saídas em ordem de custo.

Todo número da aula sai dos runbooks que já estavam na `main`: `docs/runbooks/custo-e-cota-do-supabase.md` e `docs/runbooks/supabase-sem-memoria-no-free.md`, com a região vinda do `docs/SETUP.md`. Junto vem um teste novo, porque a cerca do curso não olhava o texto: ela confere o contrato do módulo e que a tela existe no menu, e trocar um teto por um número errado dentro da lição deixava a suíte verde. O teste novo amarra cada trecho afirmado na aula ao trecho correspondente da fonte e reprova um número trocado de um lado só.

Nada muda em quem já opera uma instalação: é conteúdo de curso.

Contribuição de @webtecnica, a partir da issue #4761.
