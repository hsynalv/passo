# Test script for Passobot Pro
# PowerShell ile test etmek için

$body = @{
    team = "GS"
    ticketType = "combined"
    eventAddress = "https://www.passo.com.tr/tr/etkinlik/..."
    categoryType = "Kategori 1"
    alternativeCategory = "Kategori 2"
    prioritySale = $false
    fanCardCode = $null
    identity = $null
    email = "accountA@mail.com"
    password = "passA"
    cardHolder = "NAME SURNAME"
    cardNumber = "4111 1111 1111 1111"
    expiryMonth = "12"
    expiryYear = "29"
    cvv = "123"
    proxyHost = $null
    proxyPort = $null
    proxyUsername = $null
    proxyPassword = $null
    email2 = "accountB@mail.com"
    password2 = "passB"
} | ConvertTo-Json

Write-Host "Bot başlatılıyor..."
Write-Host "URL: http://localhost:2222/start-bot"
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri "http://localhost:2222/start-bot" `
        -Method POST `
        -Body $body `
        -ContentType "application/json"
    
    Write-Host "✅ Başarılı!" -ForegroundColor Green
    Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
    Write-Host "❌ Hata oluştu!" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
}



