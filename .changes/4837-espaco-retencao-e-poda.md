---
impacto: exige_acao
secao: corrigido
titulo: Atualização recusa antes de encher o disco, retenção de backup obedece BACKUP_KEEP e imagens antigas são podadas sem prune -a
---

Uma instalação self-hosted chegou a 73,62 GB em imagens Docker e 12 GB em backups: o disco encheu no meio de um pull, o app ficou em Created e a volta automática falhou seis vezes seguidas — cada tentativa gravando mais um backup de 1,6 GB no mesmo disco apertado. O kit passou a medir o espaço antes de qualquer escrita: se o livre não cobre o maior entre o tamanho das imagens em uso mais o do último backup (com 20% de folga) e um piso de 1 GB para quando não há como medir, o update recusa com os dois números na tela e o que libera espaço sem apagar dado, e a versão atual continua no ar. O piso é configurável em DESKCOMM_ESPACO_MINIMO_MB.

A retenção de backup deixou de ser 14 fixo: BACKUP_KEEP no .env define quantos arquivos por tipo (db, waha, storage) ficam, a poda vai do mais antigo para o mais novo e nunca apaga o último, nem quando a instalação tem um arquivo só. backup.sh --podar aplica a retenção na hora, sem gerar outro backup antes.

Depois de uma atualização saudável, o update poda as imagens: docker image prune -f com os filtros dangling=true e until=168h — nunca prune -a — e, uma a uma, as versões antigas das imagens deste produto, preservando a versão atual, a da volta registrada em .deskcomm-env-antes-do-update, qualquer imagem usada por contêiner e os canais móveis como stable. Falha da poda vira aviso e não aborta a atualização, que já está concluída quando ela roda. DESKCOMM_PODA_IMAGENS=0 desliga a poda.

## Requer atenção

Quem atualiza por uma VPS apertada pode ver o update recusar com "Falta espaço em disco": é a guarda funcionando, nada foi parado nem baixado. Rode bash hostgator-setup-kit/backup.sh --podar e docker image prune -f --filter "until=168h", ou aumente o disco, e repita o update. Não use docker image prune -a nem docker system prune --volumes: o primeiro leva embora a imagem para a qual a volta automática iria, e o segundo apaga o volume com a sessão do WhatsApp e o banco. Quem quiser manter mais ou menos backups escreve BACKUP_KEEP no .env; quem não escrever nada continua com 14, como antes.
