__aide_readline_submit() {
    if __aide_submit_prose "$READLINE_LINE"; then
        READLINE_LINE=
        READLINE_POINT=0
    fi
}

if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
    # Preserve the existing prompt hooks, including Bash's array form.
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
        PROMPT_COMMAND+=(__aide_render_prose)
    else
        PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__aide_render_prose"
    fi
    for __aide_keymap in emacs-standard vi-insert vi-command; do
        bind -m "$__aide_keymap" -x '"\e[27;9;13~":__aide_readline_submit'
        bind -m "$__aide_keymap" '"\e[27;9;14~":accept-line'
        bind -m "$__aide_keymap" '"\C-m":"\e[27;9;13~\e[27;9;14~"'
    done
    unset __aide_keymap
fi
