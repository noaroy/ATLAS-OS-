# ATLAS OS — mot de passe du compte fondateur, saisie Windows.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\founder-reset.ps1
#
# Pourquoi une version PowerShell : la saisie masquée en Node repose sur le mode
# brut du terminal, et npm relaie l'entrée standard par un tube sous Windows.
# `isTTY` y est faux, le mode brut ne s'active pas, et rien ne peut être tapé.
# `Read-Host -AsSecureString` ne dépend pas de cela : il lit directement dans la
# console, sous le contrôle de Windows.
#
# Le mot de passe est transmis à Node par l'entrée standard. Jamais en argument :
# la ligne de commande d'un processus est lisible par tout le système, et reste
# dans l'historique du shell. Jamais dans un fichier non plus, fût-il temporaire.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

function Read-Secret([string] $Label) {
    # Write-Host et non Write-Output : l'invite s'adresse à l'écran, elle n'a
    # rien à faire dans le pipeline.
    Write-Host -NoNewline "  $Label : "
    $secure = Read-Host -AsSecureString
    Write-Host ''

    # Le SecureString doit redevenir du texte pour être haché. La conversion
    # passe par un BSTR que l'on remet à zéro immédiatement après : la chaîne
    # .NET, elle, est immuable et attendra le ramasse-miettes.
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        $secure.Dispose()
    }
}

Write-Host ''
Write-Host '  ATLAS OS - mot de passe du compte fondateur' -ForegroundColor White
Write-Host '  La saisie est masquee : rien ne s affiche pendant la frappe.' -ForegroundColor DarkGray
Write-Host '  Minimum 8 caracteres.' -ForegroundColor DarkGray
Write-Host ''

$password = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $first = Read-Secret 'Nouveau mot de passe      '

    if ($first.Length -lt 8) {
        Write-Host '  Refuse - il faut au moins 8 caracteres.' -ForegroundColor Red
        Write-Host ''
        continue
    }

    $second = Read-Secret 'Confirmez le mot de passe '
    if ($first -ne $second) {
        Write-Host '  Les deux saisies different.' -ForegroundColor Red
        Write-Host ''
        continue
    }

    $password = $first
    break
}

if ($null -eq $password) {
    Write-Host ''
    Write-Host "  Abandon : trois tentatives sans saisie valable. Rien n a ete modifie." -ForegroundColor Red
    Write-Host ''
    exit 1
}

# Node reçoit le mot de passe sur son entrée standard, puis fait le reste :
# vérifications, hachage scrypt, écriture, révocation des sessions ouvertes.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = '--import tsx scripts/founder-reset.ts --stdin'
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
# La sortie n'est pas redirigée : les messages de Node vont droit à la console.

$process = [System.Diagnostics.Process]::Start($psi)
try {
    $process.StandardInput.WriteLine($password)
    $process.StandardInput.Close()
} finally {
    $password = $null
    $first = $null
    $second = $null
    [System.GC]::Collect()
}

$process.WaitForExit()
exit $process.ExitCode
