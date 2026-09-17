"""Carga explícita no destino fixado; exige artefato ensaiado e backup recente.

Uso na VPS de destino: python3 apply-native.py native-final.json.gz /opt/deskcomm-crm/backups/db-....dump
Nunca executado pelo aplicativo, worker, scheduler ou CI.
"""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location('warm_native', pathlib.Path(__file__).with_name('rehearsal-native.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.main(production=True)
