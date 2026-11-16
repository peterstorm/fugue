{
  description = "AI Summary development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        python = pkgs.python312;
        pythonPkgs = python.pkgs;

        # Bun pinned to the exact patch CI (.github/workflows/verify.yml) and
        # packages/host/Dockerfile use, so `bun run verify`'s prerequisite
        # check passes locally. Bump all three together.
        bunVersion = "1.4.2";
        bunHashes = {
          "aarch64-darwin" = { asset = "darwin-aarch64"; hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8="; };
          "x86_64-darwin" = { asset = "darwin-x64"; hash = "sha256-gFINfhdSYwjJGF0mFnmsbSd5jTgDoOn3/5Ehq4r/sBI="; };
          "aarch64-linux" = { asset = "linux-aarch64"; hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac="; };
          "x86_64-linux" = { asset = "linux-x64"; hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM="; };
        };
        bun = pkgs.bun.overrideAttrs (_: {
          version = bunVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${bunHashes.${system}.asset}.zip";
            hash = bunHashes.${system}.hash;
          };
        });
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            python
            pythonPkgs.pip
            pythonPkgs.virtualenv
            bun
            # Node 24 bundles npm >= 11.5.1, required for the release workflow's
            # OIDC trusted publishing (`npm publish`); bun handles everything else.
            pkgs.nodejs_24
            pkgs.redis
          ];

          shellHook = ''
            # Create/activate Python venv for eval dependencies
            if [ ! -d .venv ]; then
              echo "Creating Python venv..."
              python -m venv .venv || { echo "ERROR: Failed to create venv"; return 1; }
            fi
            source .venv/bin/activate

            # Install eval dependencies if not present
            if ! python -c "import mlflow; import anthropic; import pandas" 2>/dev/null; then
              echo "Installing eval dependencies..."
              pip install mlflow==3.1.0 openai==1.82.0 anthropic==0.52.0 requests==2.32.3 pandas==2.2.3 || {
                echo "WARNING: pip install failed — run manually: pip install -r requirements-eval.txt"
              }
            fi
          '';
        };
      });
}
