function wsl {
    $wslProgram = Get-Command wsl.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    # Integrate plain interactive launches. Forward WSL management commands and
    # explicit Linux commands unchanged.
    if ($args.Count -eq 0 -or ($args.Count -eq 2 -and
        $args[0] -cin @('-d', '--distribution') -and $args[1] -match '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$')) {
        $bootstrap = '__AIDE_WSL_BOOTSTRAP__'
        if (!$PSVersionTable.PSEdition -or $PSVersionTable.PSEdition -eq 'Desktop' -or
            $PSNativeCommandArgumentPassing -eq 'Legacy' -or !$PSNativeCommandArgumentPassing) {
            $bootstrap = $bootstrap.Replace('"', '\"')
        }
        try {
            & $wslProgram.Source @args --exec sh -c $bootstrap
        } finally {
            # WSL uses the same nested-shell OSC frames and execution guard as SSH.
            [Console]::Write("$([char]27)]633;AideSshEnd;__AIDE_INPUT_TOKEN__$([char]7)")
        }
    } else {
        & $wslProgram.Source @args
    }
}
