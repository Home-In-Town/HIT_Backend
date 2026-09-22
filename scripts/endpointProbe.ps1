# Probes lead-matching / lead-chat endpoints on the live backend.
# Verifies ROUTING (not 404) and AUTH ENFORCEMENT (401 without a token).
# A 401 is the correct, expected answer for a protected route.

$base = "https://sales-website-backend-624770114041.asia-south1.run.app/api"

$routes = @(
  @{ m = "POST"; p = "/lead-chat/open" },
  @{ m = "POST"; p = "/lead-chat/answer" },
  @{ m = "POST"; p = "/lead-chat/edit" },
  @{ m = "POST"; p = "/lead-chat/confirm" },
  @{ m = "POST"; p = "/lead-chat/new" },
  @{ m = "POST"; p = "/lead-matching/extract" },
  @{ m = "POST"; p = "/lead-matching/test-match" },
  @{ m = "POST"; p = "/lead-matching/confirm" },
  @{ m = "GET";  p = "/lead-matching/leads" },
  @{ m = "GET";  p = "/lead-matching/stats" },
  @{ m = "POST"; p = "/lead-matching/match-counts" },
  @{ m = "GET";  p = "/public/projects" },
  @{ m = "GET";  p = "/projects" },
  @{ m = "GET";  p = "/human-leads" }
)

$okCount = 0
$badCount = 0

foreach ($r in $routes) {
  $url = "$base$($r.p)"
  if ($r.m -eq "GET") {
    $code = & curl.exe -s -o NUL -w "%{http_code}" $url
  } else {
    $code = & curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" $url
  }

  $code = "$code".Trim()
  # Protected routes must answer 401/403. Public ones may answer 200.
  if ($code -eq "404" -or $code -eq "000" -or $code -ge "500") {
    Write-Output ("  BAD   {0,-4} {1,-34} -> {2}" -f $r.m, $r.p, $code)
    $badCount++
  } else {
    Write-Output ("  OK    {0,-4} {1,-34} -> {2}" -f $r.m, $r.p, $code)
    $okCount++
  }
}

Write-Output ""
Write-Output "Reachable/enforcing: $okCount   Problem: $badCount"
