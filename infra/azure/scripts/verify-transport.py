#!/usr/bin/env python3
"""Read-only Azure transport checks. Never fetch secrets or print env values."""
import json
import subprocess
import sys
from urllib.parse import urlparse


def az(*args):
    result = subprocess.run(['az', *args, '-o', 'json'], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Azure query failed; check authentication, permissions and resource names')
    return json.loads(result.stdout or 'null')


def verify(group):
    failed = False

    def check(label, passed):
        nonlocal failed
        print(('PASS ' if passed else 'FAIL ') + label)
        failed |= not passed

    az('group', 'show', '-n', group, '--query', 'id')
    environments = az('resource', 'list', '-g', group, '--resource-type', 'Microsoft.App/managedEnvironments', '--query', '[].name')
    check('at least two managed environments', len(environments) >= 2)
    for name in environments:
        encrypted = az('resource', 'show', '-g', group, '-n', name, '--resource-type', 'Microsoft.App/managedEnvironments', '--api-version', '2024-03-01', '--query', 'properties.peerTrafficConfiguration.encryption.enabled')
        check(f'{name}: peer encryption', encrypted is True)
    apps = az('containerapp', 'list', '-g', group, '--query', '[].name')
    check('container apps present', bool(apps))
    direct = {'EDGE_EGRESS_URL', 'EDGE_PORTAL_URL', 'PORTAL_EGRESS_URL', 'JOBS_EDGE_PROD_URL', 'JOBS_EDGE_DEV_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'AZURE_STORAGE_BLOB_ENDPOINT', 'AZURE_KEY_VAULT_URL', 'AZURE_DELEGATED_KEY_VAULT_URL'}
    for name in apps:
        data = az('containerapp', 'show', '-g', group, '-n', name, '--query', '{ingress:properties.configuration.ingress.allowInsecure,containers:properties.template.containers[].{env:env}}')
        check(f'{name}: secure ingress', data['ingress'] is False)
        for container in data['containers']:
            env = {entry['name']: entry for entry in container.get('env', [])}
            if env.get('NODE_ENV', {}).get('value') == 'production':
                check(f'{name}: HTTPS transport mode', env.get('HELIX_INTERNAL_TRANSPORT_MODE', {}).get('value', 'https') == 'https')
                check(f'{name}: no mesh exceptions', env.get('HELIX_MESH_HTTP_ORIGINS', {}).get('value', '[]') == '[]')
                check(f'{name}: TLS verification enabled', env.get('NODE_TLS_REJECT_UNAUTHORIZED', {}).get('value') != '0')
            for key in direct & env.keys():
                entry = env[key]
                check(f'{name}: {key} auditable', 'secretRef' not in entry)
                value = entry.get('value')
                if value:
                    url = urlparse(value)
                    check(f'{name}: {key} HTTPS', url.scheme == 'https' and not url.username and not url.password)
            for key in {'EDGE_JOBS_CONFIG', 'PORTAL_JOBS_CONFIG'} & env.keys():
                entry = env[key]
                if 'secretRef' in entry:
                    check(f'{name}: {key} needs in-container endpoint verification (secret not read)', False)
                    continue
                config = json.loads(entry.get('value') or '{}')
                for target in config.get('servers', {}).values():
                    check(f'{name}: {key} destination HTTPS', urlparse(target['endpoint']).scheme == 'https')
    databases = az('postgres', 'flexible-server', 'list', '-g', group, '--query', '[].name')
    check('Postgres present', bool(databases))
    for name in databases:
        for key, expected in [('require_secure_transport', 'ON'), ('ssl_min_protocol_version', 'TLSv1.2')]:
            value = az('postgres', 'flexible-server', 'parameter', 'show', '-g', group, '--server-name', name, '-n', key, '--query', 'value')
            check(f'{name}: {key}', value == expected)
    stores = az('storage', 'account', 'list', '-g', group, '--query', '[].{name:name,https:enableHttpsTrafficOnly,tls:minimumTlsVersion}')
    check('Blob storage present', bool(stores))
    for store in stores:
        check(f'{store["name"]}: HTTPS and TLS minimum', store['https'] is True and store['tls'] == 'TLS1_2')
    return int(failed)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Usage: verify-transport.py RESOURCE_GROUP')
        sys.exit(verify(sys.argv[1]))
    except Exception:
        print('FAIL verification incomplete; check Azure access and configuration (values redacted)', file=sys.stderr)
        sys.exit(1)
