#!/usr/bin/bash
# Instala o Activities Layer para o usuário atual, em modo desenvolvimento
# (symlinks para este repositório: editar o código e relogar basta).
#
#   ./install.sh            instala (extensão + CLI + receitas de exemplo)
#   ./install.sh --pack     gera activities-layer@local.shell-extension.zip em dist/
#   ./install.sh --uninstall
set -euo pipefail

REPO=$(cd "$(dirname "$0")" && pwd)
UUID=activities-layer@local
EXT_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions
BIN_DIR=$HOME/.local/bin
CONF_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/activities-layer

case ${1:-} in
--pack)
    mkdir -p "$REPO/dist"
    gnome-extensions pack --force --extra-source=lib --out-dir="$REPO/dist" "$REPO"
    echo "dist/$UUID.shell-extension.zip"
    exit 0
    ;;
--uninstall)
    gnome-extensions disable "$UUID" 2>/dev/null || true
    [ -L "$EXT_DIR/$UUID" ] && rm "$EXT_DIR/$UUID"
    [ -L "$BIN_DIR/activity" ] && rm "$BIN_DIR/activity"
    echo "Removido. Suas receitas e o estado em $CONF_DIR foram mantidos."
    exit 0
    ;;
"") ;;
*) echo "uso: $0 [--pack|--uninstall]" >&2; exit 2 ;;
esac

if [ -e "$EXT_DIR/$UUID" ] && [ ! -L "$EXT_DIR/$UUID" ]; then
    echo "$EXT_DIR/$UUID já existe e não é um symlink; remova-o antes." >&2
    exit 1
fi

glib-compile-schemas "$REPO/schemas"
mkdir -p "$EXT_DIR" "$BIN_DIR" "$CONF_DIR/recipes"
ln -sfn "$REPO" "$EXT_DIR/$UUID"
ln -sfn "$REPO/bin/activity" "$BIN_DIR/activity"

for recipe in "$REPO"/recipes/*.toml; do
    target="$CONF_DIR/recipes/$(basename "$recipe")"
    if [ -e "$target" ]; then
        echo "mantida (já existe): $target"
    else
        cp "$recipe" "$target"
        echo "receita de exemplo:  $target"
    fi
done

gnome-extensions enable "$UUID" 2>/dev/null || \
    gsettings set org.gnome.shell enabled-extensions \
        "$(python3 -c 'import ast,sys; l=ast.literal_eval(sys.argv[1].replace("@as ","")); l.append(sys.argv[2]) if sys.argv[2] not in l else None; print(l)' \
            "$(gsettings get org.gnome.shell enabled-extensions)" "$UUID")"

cat <<EOF

Instalado:
  extensão  $EXT_DIR/$UUID -> $REPO
  CLI       $BIN_DIR/activity

No Wayland o GNOME Shell só descobre extensões novas no login:
saia da sessão e entre de novo. Depois:  activity list
EOF
