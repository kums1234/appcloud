# VHS tape script for the AppCloud chat REPL demo (support scenario).
#
# Generates demo/chat.gif (~35s). Re-run with:
#   vhs demo/chat.tape
#
# Pre-reqs (same as demo/demo.tape):
#   1. AppCloud is up locally and reachable on http://localhost:3000.
#   2. agents/seed.js has been run against the `default` tenant.
#   3. agents/.env populated: APPCLOUD_API_KEY (super-admin),
#      APPCLOUD_TENANT_SLUG=default, AI_PROVIDER=gemini, GEMINI_API_KEY,
#      GEMINI_MODEL=gemini-2.5-flash.
#
# Records real output — chat REPL forwards Gemini creds to /ai/chat via
# cloudOverride; the route injects a live graph snapshot before answering.

Output demo/chat.gif

Set FontSize 14
Set Width 1100
Set Height 720
Set TypingSpeed 40ms
Set PlaybackSpeed 1.0
Set Theme "Catppuccin Mocha"
Set Padding 20
Set BorderRadius 8

# ── Title ───────────────────────────────────────────────────────────────────
Type "# AppCloud chat — on-call: portal team just paged"
Sleep 2s
Enter
Type "# 'what does User Portal depend on, and what depends on it?'"
Sleep 1500ms
Enter
Sleep 500ms

# ── Open the REPL ───────────────────────────────────────────────────────────
Type "cd agents"
Enter
Sleep 500ms

Type "node run.js chat"
Enter

# Banner + 'you>' prompt take a beat to render after node spins up.
Sleep 3500ms

# ── Ask the question ────────────────────────────────────────────────────────
Type "What does [seed] User Portal depend on, and what apps depend on it?"
Sleep 800ms
Enter

# /ai/chat round-trip with Gemini Flash typically lands in 5-10s; pad
# generously so the structured reply + meta line both stick on screen.
Sleep 18s

# Final readability pause on the answer.
Sleep 5s

# ── Exit cleanly ────────────────────────────────────────────────────────────
Type ":exit"
Enter
Sleep 1500ms
