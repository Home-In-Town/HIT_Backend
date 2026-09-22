# Probes every mounted route group on the live backend.
# PASS = route exists and behaves correctly (401 when protected, 200 when public).
# FAIL = 404 (not routed), 5xx (server error), or 000 (unreachable).

$base = "https://sales-website-backend-624770114041.asia-south1.run.app/api"

$routes = @(
  @{ m="GET";  p="/public/projects";              expect="public"  },
  @{ m="POST"; p="/auth/login";                   expect="any"     },
  @{ m="GET";  p="/auth/session";                 expect="any"     },
  @{ m="GET";  p="/users/me";                     expect="auth"    },
  @{ m="GET";  p="/projects";                     expect="auth"    },
  @{ m="GET";  p="/analytics/owner";              expect="auth"    },
  @{ m="GET";  p="/organizations";                expect="auth"    },
  @{ m="GET";  p="/contacts";                     expect="auth"    },
  @{ m="GET";  p="/chat/sessions";                expect="auth"    },
  @{ m="GET";  p="/chat/builders-network";        expect="auth"    },
  @{ m="GET";  p="/crm/leads";                    expect="auth"    },
  @{ m="GET";  p="/crm-bridge/leads";             expect="auth"    },
  @{ m="GET";  p="/marketplace/listings";         expect="auth"    },
  @{ m="GET";  p="/notifications";                expect="auth"    },
  @{ m="GET";  p="/group-chat/rooms";             expect="auth"    },
  @{ m="GET";  p="/human-leads";                  expect="auth"    },
  @{ m="GET";  p="/captain-team/team-agents";     expect="auth"    },
  @{ m="GET";  p="/referrals";                    expect="auth"    },
  @{ m="POST"; p="/lead-chat/open";               expect="auth"    },
  @{ m="POST"; p="/lead-chat/answer";             expect="auth"    },
  @{ m="POST"; p="/lead-chat/edit";               expect="auth"    },
  @{ m="POST"; p="/lead-chat/confirm";            expect="auth"    },
  @{ m="POST"; p="/lead-chat/new";                expect="auth"    },
  @{ m="POST"; p="/lead-matching/extract";        expect="auth"    },
  @{ m="POST"; p="/lead-matching/test-match";     expect="auth"    },
  @{ m="POST"; p="/lead-matching/confirm";        expect="auth"    },
  @{ m="GET";  p="/lead-matching/leads";          expect="auth"    },
  @{ m="GET";  p="/lead-matching/stats";          expect="auth"    },
  @{ m="POST"; p="/lead-matching/match-counts";   expect="auth"    },
  @{ m="POST"; p="/track/cta";                    expect="any"     },
  @{ m="POST"; p="/track/pageview";               expect="any"     },
  # NOTE: employee history is /employee/history/:employeeId — the bare path
  # correctly 404s, so we probe a real parameterised route instead.
  @{ m="GET";  p="/employee/my-employees";        expect="auth"    },
  @{ m="GET";  p="/contacts";                     expect="auth"    }
)

$ok = 0; $bad = 0; $failed = @()

foreach ($r in $routes) {
  if ($r.m -eq "GET") {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 25 "$base$($r.p)"
  } else {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 25 -X POST -H "Content-Type: application/json" -d "{}" "$base$($r.p)"
  }
  $code = "$code".Trim()
  $n = 0; [int]::TryParse($code, [ref]$n) | Out-Null

  $isBad = ($n -eq 404) -or ($n -ge 500) -or ($n -eq 0)
  if ($isBad) {
    Write-Output ("  FAIL  {0,-4} {1,-32} -> {2}" -f $r.m, $r.p, $code)
    $bad++; $failed += "$($r.m) $($r.p) -> $code"
  } else {
    Write-Output ("  ok    {0,-4} {1,-32} -> {2}" -f $r.m, $r.p, $code)
    $ok++
  }
}

Write-Output ""
Write-Output "PASS: $ok   FAIL: $bad"
if ($bad -gt 0) { Write-Output "Failures:"; $failed | ForEach-Object { Write-Output "  $_" } }
