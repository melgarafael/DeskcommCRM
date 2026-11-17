---
impacto: nada_mudou
secao: corrigido
titulo: O link do README para o runbook do Supabase abre na seção do compute Nano, não no topo
---

No README, a linha da tabela de pré-requisitos que manda procurar o runbook quando o projeto fica fora do ar parado (`522` ou `PGRST002` por horas) apontava para a âncora da seção 5 — o número que a seção do compute Nano tinha antes de a seção de Log ingestion entrar como 5. Quem clicava caía no topo do runbook e tinha de achar o trecho de olho. A âncora agora é a da seção 6, a mesma que o sumário do próprio runbook usa. Nada muda em quem já opera uma instalação: é um ponteiro de documentação.
