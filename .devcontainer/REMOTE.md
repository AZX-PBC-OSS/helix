# Phone access with Moshi and Herdr

The app container runs OpenSSH as its main process. Log in as `node` with a
public key; password authentication, root login, and SSH agent forwarding are
disabled. Herdr and the coding agents run inside this container.

## First connection

Replace `ssh.example.com` below with your own SSH hostname.

1. If you already use Herdr without a persistent volume, back up its saved state
   before rebuilding. Run this inside the current container:

   ```bash
   umask 077
   tar --exclude='*.sock' --exclude='*.log' --exclude='*.pid' \
     -cf /workspace/.devcontainer/herdr-before-rebuild.tar -C ~/.config/herdr .
   ```

   Rebuild the dev container in VS Code to install the tools, mount the persistent
   volumes, and publish the ports. A rebuild stops running agent processes.
   If you created a backup, restore it before starting Herdr:

   ```bash
   tar -xf /workspace/.devcontainer/herdr-before-rebuild.tar -C ~/.config/herdr
   ```

   The archive is gitignored. It restores saved state, not running processes.
   Subsequent rebuilds use the named volume and do not need this step.

2. Reserve the Docker host's LAN address in the router. Keep the Docker host awake and Docker
   running while using it remotely.
3. Forward TCP port `51271` on the router to port `51271` on the Docker host. Allow that
   traffic through the Docker host's firewall. Docker maps it to container port `22`.
4. Confirm `ssh.example.com` resolves to the router's public IPv4 address. Use
   DNS-only if the DNS provider offers HTTP proxying. Do not advertise an IPv6
   address unless its separate routing/firewall path also works.
5. In a VS Code terminal **inside the container**, run:

   ```bash
   moshi-hook host setup --host ssh.example.com --port 51271 --user node --name Helix
   ```

   Scan the QR using Moshi's Easy Pair. The phone creates its private key and the
   setup command installs the public key in `node`'s `authorized_keys`. Treat the
   QR as a temporary access credential. Start with SSH transport to test TCP
   access separately from Mosh.

6. Connect from the phone over cellular. The connection should use hostname
   `ssh.example.com`, port `51271`, and username `node`. In the remote terminal:

   ```bash
   cd /workspace
   herdr
   ```

Compare the SSH host fingerprint shown by the phone with this command in VS Code:

```bash
sudo ssh-keygen -lf /var/lib/helix-ssh/ssh_host_ed25519_key.pub
```

## Enable Mosh

Forward UDP ports `60000–60010` from the router to the same ports on the Docker host and
allow them through its firewall. Docker publishes the same range into the
container. Set Moshi's UDP port range to `60000–60010`, then choose Mosh or Auto
transport. Mosh first uses SSH to authenticate, then uses UDP for the terminal.
The UDP port numbers must match across the router, Mac, and container.

## Persistence and environment

Named volumes retain authorized keys, SSH host keys, Herdr configuration/session
state, and Moshi configuration. Agent credentials and conversations retain their
existing volumes. Do not remove these volumes during a rebuild. Running processes
survive a phone disconnect, but not a container stop or rebuild.

The startup script exports the Compose project variables into a private runtime
file for Bash and Zsh sessions because SSH does not inherit them automatically.
It excludes SSH agent forwarding and unrelated environment variables.

The Moshi hook daemon and agent notification hooks are optional and are not
started or installed by this setup. Use `herdr`, not the `moshi` project launcher,
to open the workspace; that launcher targets tmux.

Sources: [Moshi setup](https://getmoshi.app/docs/install),
[Mosh networking](https://getmoshi.app/articles/fix-mosh-connection-failed), and
[Herdr remote access](https://herdr.dev/docs/how-to-work/).
