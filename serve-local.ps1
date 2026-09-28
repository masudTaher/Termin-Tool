$ErrorActionPreference = 'Stop'
$root = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\') + '\'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 8765)

try {
    $listener.Start()
} catch {
    Write-Host 'Der lokale Port 8765 ist belegt. Schließe das andere Programm und starte diese Datei erneut.' -ForegroundColor Red
    exit 1
}

Write-Host 'Termin-Tool läuft nur auf diesem Computer: http://127.0.0.1:8765/' -ForegroundColor Cyan
Write-Host 'Zum Beenden hier Strg+C drücken.'
try {
    Start-Process 'http://127.0.0.1:8765/'
} catch {
    Write-Host 'Der Browser konnte nicht automatisch geöffnet werden. Kopiere die Adresse oben in deinen Browser.' -ForegroundColor Yellow
}

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}
$allowedFiles = @(
    'index.html',
    'style.css',
    'workflowStorage.js',
    'termineFiltern.html',
    'termineFilternApp.js',
    'termineBearbeiten.html',
    'termineBearbeitenApp.js',
    'termineTracking.html',
    'termineTrackingApp.js'
)

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            $headerLine = $reader.ReadLine()
            while ($null -ne $headerLine -and $headerLine -ne '') {
                $headerLine = $reader.ReadLine()
            }

            $statusCode = 200
            $statusText = 'OK'
            $body = [byte[]]@()
            $contentType = 'application/octet-stream'

            if ($requestLine -notmatch '^GET\s+(\S+)') {
                $statusCode = 405
                $statusText = 'Method Not Allowed'
            } else {
                $requestedPath = [Uri]::UnescapeDataString(($Matches[1] -split '\?')[0]).TrimStart('/')
                if ([string]::IsNullOrWhiteSpace($requestedPath)) {
                    $requestedPath = 'index.html'
                }

                if ($requestedPath -notin $allowedFiles) {
                    $statusCode = 403
                    $statusText = 'Forbidden'
                } else {
                    $filePath = Join-Path $root $requestedPath
                    if (-not [System.IO.File]::Exists($filePath)) {
                        $statusCode = 404
                        $statusText = 'Not Found'
                    } else {
                        $body = [System.IO.File]::ReadAllBytes($filePath)
                        $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                        if ($contentTypes.ContainsKey($extension)) {
                            $contentType = $contentTypes[$extension]
                        }
                    }
                }
            }

            if ($statusCode -ne 200) {
                $body = [System.Text.Encoding]::UTF8.GetBytes($statusText)
                $contentType = 'text/plain; charset=utf-8'
            }

            $responseHeaders = "HTTP/1.1 $statusCode $statusText`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($responseHeaders)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($body.Length -gt 0) {
                $stream.Write($body, 0, $body.Length)
            }
            $stream.Flush()
        } catch {
            # Browser can close a connection while requesting an asset; keep serving other requests.
        } finally {
            if ($null -ne $client) {
                $client.Close()
            }
        }
    }
} finally {
    $listener.Stop()
}
