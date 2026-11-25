#!/bin/sh
# Warden never blocks a tool call (Ryan, 2026-11-24: "warden should not be
# blocking anything ever"). Every path reports on stderr or as agent context
# and exits 0.
root=$(pwd -P)
until [ -f "$root/.warden/config.yaml" ]; do
  [ "$root" = / ] && exit 0
  root=$(dirname "$root")
done
input=$(cat)
policy="$root/.warden/generated/hooks/command-replacements.json"
here=$(dirname "$0")
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../.claude-plugin/plugin.json")
installed=$(warden --version 2>/dev/null)
problem=
if [ -z "$installed" ] && command -v warden >/dev/null 2>&1; then
  errors=$(warden --version 2>&1 >/dev/null)
  status=$?
  problem=$(printf '%s\n' "$errors" | grep 'Next action:' | tail -n 1)
  [ -n "$problem" ] || problem="warden --version failed with exit status $status and printed: $errors. Next action: run warden --version in $root and fix what it names."
fi
lowest=$(printf '%s\n%s\n' "$installed" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)
if [ -z "$installed" ] || { [ "$installed" != "$version" ] && [ "$lowest" = "$installed" ]; }; then
  [ -n "$problem" ] || problem="The Warden plugin $version needs the global warden $version or later, and the global warden is ${installed:-not on PATH}. Next action: run npm install -g git+https://github.com/RyanAmundson/warden.git#v$version."
  echo "Warden did not run. $problem" >&2
  exit 0
fi
case $1 in
  guard)
    if [ -f "$policy" ]; then
      printf '%s' "$input" | warden guard --compiled-replacements
    else
      printf '%s' "$input" | warden guard
    fi
    ;;
  check) printf '%s' "$input" | warden check --format agent --hook claude ;;
  session-end) printf '%s' "$input" | warden session-end ;;
  *) echo "usage: warden.sh guard|check|session-end" >&2 ;;
esac
code=$?
[ "$code" -eq 0 ] || echo "warden exited $code. Warden never blocks a tool call, so the call continues. Next action: run warden doctor in $root and fix what it names." >&2
exit 0
