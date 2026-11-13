# Returns success only after handing an unrecognized prose line back to Aide.
__aide_submit_prose() {
    local LC_ALL=C
    local line name payload
    line=${1#"${1%%[![:space:]]*}"}
    case "$line" in
        [$'\xe4'-$'\xe9']*|[Pp]lease\ *|[Hh]ow\ do\ I\ *|[Hh]ow\ can\ I\ *) ;;
        *) return 1 ;;
    esac
    case "$line" in
        *[[:cntrl:]]*|*';'*|*'|'*|*'&'*|*'<'*|*'>'*|*'$'*|*'`'*|*'('*|*')'*) return 1 ;;
    esac
    [ "${#line}" -le 4000 ] || return 1
    name=${line%%[[:space:]]*}
    case "$name" in
        *[./\\\"\']*) return 1 ;;
    esac
    type -- "$name" >/dev/null 2>&1 && return 1
    payload=$(printf '%s' "$line" | command base64 | command tr -d '\r\n')
    [ -n "$payload" ] || return 1
    __aide_prose_line=$line
    __aide_prose_payload=$payload
}

__aide_render_prose() {
    if [ -n "${__aide_prose_payload-}" ]; then
        printf '%s\n\033]633;AideInputBlock;__AIDE_INPUT_TOKEN__;%s\007\n\n\n\n' "$__aide_prose_line" "$__aide_prose_payload"
        unset __aide_prose_line __aide_prose_payload
    fi
}
