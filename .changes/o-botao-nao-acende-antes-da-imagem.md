---
impacto: capacidade_nova
secao: corrigido
titulo: O aviso de versão nova só aparece quando ela está pronta para instalar
---

Medido numa instalação real, e quem viu foi quem opera: a tela ofereceu uma versão nova **enquanto ela ainda estava sendo preparada**. O aviso olhava só o número da versão publicada e nunca perguntava se já havia o que baixar. São cerca de seis minutos entre uma coisa e outra.

Antes isso era um susto: a atualização avisava *"a versão ainda está publicando, tente de novo em alguns minutos"* e o sistema seguia no ar com a versão antiga, porque nada tinha sido parado.

Com a pausa dos serviços — que é o que impede a atualização de apagar regras de acesso — deixou de ser susto. O sistema é parado antes de mexer no banco, e a volta usa a versão nova. Sem ela pronta, ele não volta.

Agora o aviso confere se a versão está mesmo disponível antes de aparecer.

**E ele não desaparece por problema de rede.** Se o servidor não conseguir nem perguntar, o aviso continua aparecendo como sempre — porque uma instalação com internet instável não pode ficar sem atualização para sempre, em silêncio. A diferença entre "ainda não está pronta" e "não consegui perguntar" é medida comparando com a versão que já está instalada: ela existe com certeza, então se nem ela responde, o que está fora é a rede.
