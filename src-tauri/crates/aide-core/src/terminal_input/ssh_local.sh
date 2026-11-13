ssh() {
    if [ "$#" -eq 1 ] && [[ $1 =~ ^[[:alnum:]_][[:alnum:]_.@-]*$ ]]; then
        command ssh -t "$1" __AIDE_SSH_BOOTSTRAP__
        local status_code=$?
        printf '\033]633;AideSshEnd;__AIDE_INPUT_TOKEN__\007'
        return "$status_code"
    fi
    command ssh "$@"
}
