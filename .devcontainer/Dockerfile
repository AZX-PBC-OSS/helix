# TypeScript/Node monorepo dev image. The MS typescript-node base ships Node 24,
# npm, git, zsh + oh-my-zsh, and a non-root `node` user (uid 1000) with sudo.
FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

# ── System packages ──────────────────────────────────────────
# postgresql-client → psql/pg_isready against the db service.
RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-client jq fzf vim less \
    && rm -rf /var/lib/apt/lists/*

# ── gh CLI ───────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ── Everything below runs as the unprivileged `node` user ────
USER node

# ── Coding agents ────────────────────────────────────────────
# Claude Code via the native installer (no Node dependency); codex + opencode
# as global npm packages. Their *configs* live in named volumes (see compose),
# so logins survive rebuilds; the binaries are baked into the image.
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN npm install -g @openai/codex opencode-ai

# claude installs to ~/.local/bin
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/node/.zshrc \
    && echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/node/.bashrc

WORKDIR /workspace
