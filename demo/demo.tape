# VHS tape script for the AppCloud README demo.
#
# Generates demo/demo.gif (~45s). Re-run with:
#   vhs demo/demo.tape
#
# Pre-reqs:
#   1. AppCloud is up locally and reachable on http://localhost:3000:
#        ./k8s/scripts/deploy-minikube.sh --api-only
#        kubectl -n appcloud port-forward svc/api 3000:3000 &
#   2. agents/seed.js has been run against the `default` tenant.
#   3. agents/.env populated: APPCLOUD_API_KEY (super-admin),
#      APPCLOUD_TENANT_SLUG=default, AI_PROVIDER=gemini, GEMINI_API_KEY,
#      GEMINI_MODEL=gemini-2.5-flash (lite is too small for tool reasoning).
#
# Records real output — every command actually runs against the live API
# and Gemini. No mocked responses.

Output demo/demo.gif

Set FontSize 14
Set Width 1100
Set Height 720
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"
Set Padding 20
Set BorderRadius 8

# ── Title ───────────────────────────────────────────────────────────────────
Type "# AppCloud — answer 'if X changes, what's affected?' from a real graph"
Sleep 2s
Enter
Type "# Pre-change review:  what breaks if we restart [seed] prod-payment-rds?"
Sleep 2s
Enter
Sleep 500ms

# ── Run the blast-radius agent against the live API ────────────────────────
Type "cd agents"
Enter
Sleep 500ms

Type "node run.js blast-radius --subject 'What apps are affected if [seed] prod-payment-rds restarts?'"
Enter

# The agent prints its model + tool calls + final BLAST_RADIUS_RESULT.
# Sleep covers Gemini round-trips (≈ 25-30s for two tool calls + final answer)
# plus a pause on the final structured result.
Sleep 45s

# Closing pause on the BLAST_RADIUS_RESULT block.
Sleep 4s
