#!/usr/bin/env bash
set -euo pipefail

# Compose starts this as root through sudo -E; agents still run as node.
install -d -m 755 /run/sshd
install -d -m 700 /var/lib/helix-ssh
for dir in /home/node/.ssh /home/node/.config/herdr /home/node/.config/moshi; do
  install -d -o node -g node -m 700 "$dir"
done

if [[ ! -f /var/lib/helix-ssh/ssh_host_ed25519_key ]]; then
  ssh-keygen -q -t ed25519 -N '' -f /var/lib/helix-ssh/ssh_host_ed25519_key
fi

# SSH does not inherit Compose's application environment. Keep the exported
# values private to root/node and quote them as shell data, never executable code.
umask 077
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
const allowed = /^(DATABASE_URL|TEST_DATABASE_URL|BLOB_CONTAINER|NODE_EXTRA_CA_CERTS|COREPACK_ENABLE_DOWNLOAD_PROMPT|(?:PORTAL_|EDGE_|EGRESS_|HELIX_|AZX_|AZURE_|DEV_|APP_PUBLIC_|OTEL_)[A-Z0-9_]+)$/;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const lines = Object.entries(process.env)
  .filter(([name]) => allowed.test(name))
  .map(([name, value]) => `export ${name}=${quote(value)}`);
lines.push('export PATH="/home/node/.local/bin:/usr/local/share/npm-global/bin:$PATH"');
lines.push('export GIT_TERMINAL_PROMPT=0');
writeFileSync('/run/helix-remote-env', lines.join('\n') + '\n', { mode: 0o600 });
JS
chown root:node /run/helix-remote-env
chmod 640 /run/helix-remote-env

/usr/sbin/sshd -t -f /etc/ssh/helix_sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/helix_sshd_config
