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
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            python
            pythonPkgs.pip
            pythonPkgs.virtualenv
            pkgs.bun
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
