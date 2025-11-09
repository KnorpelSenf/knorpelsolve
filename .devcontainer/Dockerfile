FROM mcr.microsoft.com/devcontainers/rust:2-1-bookworm

RUN apt-get update && \
    DEBIEN_FRONTEND=noninteractive apt-get install -y \
    --no-install-recommends \
    ## dev
    vim curl jq tmux \
    ## C(++) build chain (HiGHS)
    cmake clang && \
    ## reduce image size
    rm -rf /var/lib/apt/lists/*

COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno

USER vscode

# set up shell completions for various tools
RUN mkdir -p ~/.local/share/bash-completion/completions && \
    rustup completions bash > ~/.local/share/bash-completion/completions/rustup && \
    rustup completions bash cargo > ~/.local/share/bash-completion/completions/cargo && \
    deno completions bash > ~/.local/share/bash-completion/completions/deno
