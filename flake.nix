{
  description = "Swiftnest development shell (Node, pnpm, Rust, Tauri 2 Linux libraries)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, rust-overlay }:
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
      # Android SDK/NDK are unfree-licensed; only the opt-in `android` shell accepts them.
      androidPkgs = system: import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
        config = { allowUnfree = true; android_sdk.accept_license = true; };
      };
      androidShell = system: base:
        let
          pkgs = androidPkgs system;
          sdk = (pkgs.androidenv.composeAndroidPackages {
            platformVersions = [ "34" "35" "36" ];
            buildToolsVersions = [ "34.0.0" "35.0.0" "36.0.0" ];
            includeNDK = true;
            ndkVersions = [ "27.2.12479018" ];
            cmdLineToolsVersion = "latest";
          }).androidsdk;
          rust = pkgs.rust-bin.stable.latest.default.override {
            targets = [ "aarch64-linux-android" "armv7-linux-androideabi" "x86_64-linux-android" "i686-linux-android" ];
          };
          home = "${sdk}/libexec/android-sdk";
          # Tauri invokes pnpm again from its build hook and Gradle tasks. Use
          # the workspace-pinned version through the official Node's Corepack.
          pnpm = pkgs.writeShellScriptBin "pnpm" ''
            exec ${officialNode pkgs}/bin/corepack pnpm "$@"
          '';
        in pkgs.mkShell {
          inputsFrom = [ base ];
          nativeBuildInputs = [ rust pkgs.jdk17 sdk pnpm ];
          ANDROID_HOME = home;
          ANDROID_SDK_ROOT = home;
          NDK_HOME = "${home}/ndk/27.2.12479018";
          JAVA_HOME = pkgs.jdk17.home;
          # Gradle downloads its own aapt2, which cannot run on NixOS; use the SDK's.
          GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${home}/build-tools/36.0.0/aapt2";
        };
    in {
      devShells = forAll (pkgs: rec {
        android = androidShell pkgs.stdenv.hostPlatform.system default;
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
