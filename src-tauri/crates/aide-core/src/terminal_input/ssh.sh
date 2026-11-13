set -eu
login_shell=${SHELL:-/bin/sh}
case "${login_shell##*/}" in
    bash|zsh) shell=${SHELL##*/} ;;
    *) exec "$login_shell" -i ;;
esac
command -v base64 >/dev/null 2>&1 || exec "$SHELL" -i
case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) exec "$SHELL" -i ;;
esac
directory=$(mktemp -d) || exec "$SHELL" -i
trap 'rm -f -- "$directory/bashrc" "$directory/.zshenv" "$directory/.zshrc"; rmdir -- "$directory"' EXIT
guard=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[ "${#guard}" -eq 32 ] || { "$SHELL" -i; exit; }
export AIDE_SSH_EXECUTION_GUARD="$guard"

case "$shell" in
    bash)
        cat > "$directory/bashrc" <<'AIDE_BASH'
__AIDE_BASH_RC__
AIDE_BASH
        set -- --rcfile "$directory/bashrc" -i
        ;;
    zsh)
        cat > "$directory/.zshenv" <<'AIDE_ZSH_ENV'
__AIDE_ZSH_ENV__
AIDE_ZSH_ENV
        cat > "$directory/.zshrc" <<'AIDE_ZSH_RC'
__AIDE_ZSH_RC__
AIDE_ZSH_RC
        if [ "${ZDOTDIR+x}" ]; then export AIDE_TERMINAL_ZDOTDIR="$ZDOTDIR"; fi
        export ZDOTDIR="$directory"
        set -- -i
        ;;
esac
printf '\033]633;AideSshStart;__AIDE_INPUT_TOKEN__;%s;%s;%s\007' "$os" "$shell" "$guard"
"$SHELL" "$@"
