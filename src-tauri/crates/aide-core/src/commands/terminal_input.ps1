$aideInputToken = '__AIDE_INPUT_TOKEN__'
function ssh {
    $sshProgram = Get-Command ssh -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($args.Count -eq 1 -and $args[0] -match '^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$') {
        $bootstrap = '__AIDE_SSH_BOOTSTRAP__'
        if (!$PSVersionTable.PSEdition -or $PSVersionTable.PSEdition -eq 'Desktop' -or
            $PSNativeCommandArgumentPassing -eq 'Legacy' -or !$PSNativeCommandArgumentPassing) {
            $bootstrap = $bootstrap.Replace('"', '\"')
        }
        try {
            & $sshProgram.Source -t $args[0] $bootstrap
        } finally {
            [Console]::Write("$([char]27)]633;AideSshEnd;__AIDE_INPUT_TOKEN__$([char]7)")
        }
    } else {
        & $sshProgram.Source @args
    }
}
if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
    $aideEnter = {
        param($key, $arg)
        $line = ''
        $cursor = 0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $request = $line.Trim()
        if ($request.Length -le 1000 -and $request -notmatch '[\x00-\x1f\x7f]' -and
            $request -match '^(?:\p{IsCJKUnifiedIdeographs}|(?:please\s+|how (?:do|can) I\s+))') {
            $tokens = $null
            $parseErrors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseInput(
                $request, [ref]$tokens, [ref]$parseErrors)
            $statements = $ast.EndBlock.Statements
            if (!$parseErrors -and $statements.Count -eq 1 -and
                $statements[0] -is [System.Management.Automation.Language.PipelineAst]) {
                $elements = $statements[0].PipelineElements
                if ($elements.Count -eq 1 -and
                    $elements[0] -is [System.Management.Automation.Language.CommandAst] -and
                    !$elements[0].Redirections.Count) {
                    $name = $elements[0].GetCommandName()
                    if ($name -match '^[\p{L}\p{N}_-]+$' -and
                        !(Get-Command -Name $name -ErrorAction Ignore)) {
                        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($request))
                        [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine($key, $arg)
                        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($key, $arg)
                        [Console]::WriteLine($request)
                        [Console]::Write("$([char]27)]633;AideInputBlock;$aideInputToken;$payload$([char]7)")
                        [Console]::Write([Environment]::NewLine * 4)
                        return
                    }
                }
            }
        }
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine($key, $arg)
    }.GetNewClosure()
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock $aideEnter
}
