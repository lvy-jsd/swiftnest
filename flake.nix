{
  description = "Swiftnest development shell (Node, pnpm, Rust, Tauri 2 Linux libraries)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # DSH's native addon (node-addon-require-builtin) only recognizes the official nodejs.org
      # build of Node; the Nix-built nodejs fails at host preparation. See docs/en/dev/dsh-integration.md.
      officialNode = pkgs:
        let
          version = "24.21.0";
          arch = { x86_64-linux = "x64"; aarch64-linux = "arm64"; }.${pkgs.stdenv.hostPlatform.system};
          hash = {
            x64 = "sha256-/Y5Z1aURUQ9qKYr7VI8Yx9KxvkBNi0on2U++SfVsstY=";
            arm64 = "sha256-atEyXtvbVknDebdaI3FHpmbJXU+a6NNA/vLRV10omtI=";
          }.${arch};
        in pkgs.stdenv.mkDerivation {
          pname = "nodejs-official";
          inherit version;
          src = pkgs.fetchurl {
            url = "https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.xz";
            inherit hash;
          };
          dontConfigure = true;
          dontBuild = true;
          dontStrip = true;
          dontPatchELF = true;
          # Left unpatched on purpose: patchelf'd node segfaults. It runs through nix-ld
          # (NixOS: programs.nix-ld.enable = true); the shell below points nix-ld at the libraries.
          installPhase = "mkdir -p $out && cp -r bin include lib share $out/";
        };
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [ pkg-config (officialNode pkgs) pnpm rustc cargo clippy rustfmt bubblewrap ];
          buildInputs = with pkgs; [
            webkitgtk_4_1 gtk3 libsoup_3 glib cairo pango gdk-pixbuf atk librsvg openssl
          ];
          # WebKitGTK picks a broken DMA-BUF renderer on some GPUs; this keeps `tauri dev` usable.
          WEBKIT_DISABLE_DMABUF_RENDERER = "1";
          # Use the pnpm from this shell instead of fetching the exact packageManager build.
          npm_config_manage_package_manager_versions = "false";
          NIX_LD = pkgs.lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker";
          NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
        };
      });
    };
}
