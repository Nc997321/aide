__aide_ssh_guard=$AIDE_SSH_EXECUTION_GUARD
unset AIDE_SSH_EXECUTION_GUARD

__aide_ssh_execute() {
    [ "$#" -eq 2 ] && [ -n "${__aide_ssh_guard-}" ] && [ "$1" = "$__aide_ssh_guard" ] || return 1
    local line
    # GNU and BSD base64 both accept -d.
    line=$(printf '%s' "$2" | command base64 -d) || return 1
    eval "$line"
}
