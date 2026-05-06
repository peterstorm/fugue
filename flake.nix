{
  description = "AI Summary development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
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
            pkgs.redis
          ];

          shellHook = ''
            # Create/activate Python venv for eval dependencies
            if [ ! -d .venv ]; then
              echo "Creating Python venv..."
              python -m venv .venv
            fi
            source .venv/bin/activate

            # Install eval dependencies if not present
            if ! python -c "import mlflow" 2>/dev/null; then
              echo "Installing eval dependencies..."
              pip install --quiet mlflow openai anthropic requests pandas
            fi
          '';
        };
      });
}
