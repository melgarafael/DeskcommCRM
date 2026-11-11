---
impacto: nada_mudou
secao: corrigido
titulo: Dois backups no mesmo segundo não escrevem mais no mesmo arquivo
---

O backup diário e o backup de segurança da atualização podiam começar no mesmo
segundo e escrever no mesmo arquivo temporário, o que podia estragar um backup
já aprovado. O `backup.sh` passa a usar uma trava na própria pasta de backups:
o backup de segurança da atualização espera o que está em curso terminar (até
5 minutos) e, se não der, a atualização para com aviso em vez de seguir sem
backup; o backup diário, se já houver outro rodando, sai avisando sem tocar em
nenhum arquivo. Nada a configurar. Contribuição de @webtecnica.
