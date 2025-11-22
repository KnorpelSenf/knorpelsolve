FROM mcr.microsoft.com/devcontainers/rust:2-1-trixie

RUN apt-get update && \
    DEBIEN_FRONTEND=noninteractive apt-get install -y \
    --no-install-recommends \
    ## dev
    vim curl jq tmux \
    ## C(++) build chain (HiGHS)
    cmake clang gcc-aarch64-linux-gnu g++-aarch64-linux-gnu && \
    ## reduce image size
    rm -rf /var/lib/apt/lists/*

COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno

USER vscode

RUN \
    # install arm compile targets
    rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu && \
    \
    # install tool to upgrade deps
    cargo install cargo-edit && \
    \
    # set up shell completions for various tools
    mkdir -p ~/.local/share/bash-completion/completions && \
    rustup completions bash > ~/.local/share/bash-completion/completions/rustup && \
    rustup completions bash cargo > ~/.local/share/bash-completion/completions/cargo && \
    deno completions bash > ~/.local/share/bash-completion/completions/deno
