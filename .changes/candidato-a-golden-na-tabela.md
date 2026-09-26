---
impacto: nada_mudou
secao: corrigido
titulo: O candidato ao golden set sai do disco e vira linha sem texto de cliente
---

Os candidatos de curadoria que o matcher de skills e o classificador de etapa gravavam em
`lib/agent-engine/golden-candidates/` deixam de existir como arquivo: agora são linhas em
`golden_candidates`, com o rótulo (skill + motivo, ou os dois estágios da divergência) e os
ponteiros do lead e do job — sem texto de cliente. Em desenvolvimento a pasta ficava dentro
do repositório, e em produção o JSON ia para o disco do contêiner, onde nenhuma tela lia,
se perdia a cada atualização de imagem e ficava fora da cascata de anonimização. A linha
nova é alcançada pela retenção (`fn_expurgar_candidatos_do_golden`, 90 dias, piso 30, no
cron `data-retention`); quem quiser ler a conversa abre a ficha pelo ponteiro. Nada muda na
operação de quem já roda o sistema.
