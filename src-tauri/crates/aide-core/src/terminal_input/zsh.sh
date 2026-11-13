__aide_zle_submit() {
    if __aide_submit_prose "$BUFFER"; then
        BUFFER=
    fi
    zle .accept-line
}

precmd_functions+=(__aide_render_prose)
zle -N __aide_zle_submit
for __aide_keymap in emacs viins vicmd; do
    bindkey -M "$__aide_keymap" '^M' __aide_zle_submit
done
unset __aide_keymap
