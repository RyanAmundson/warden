#!/bin/sh
root=$(pwd -P)
until [ -f "$root/.warden/config.yaml" ]; do
  [ "$root" = / ] && exit 0
  root=$(dirname "$root")
done
input=$(cat)
here=$(dirname "$0")
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../.claude-plugin/plugin.json")
installed=$(warden --version 2>/dev/null)
refusal=
if [ -z "$installed" ] && command -v warden >/dev/null 2>&1; then
  refusal=$(warden --version 2>&1 >/dev/null | grep 'Next action:' | tail -n 1)
fi
lowest=$(printf '%s\n%s\n' "$installed" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)
if [ -z "$installed" ] || { [ "$installed" != "$version" ] && [ "$lowest" = "$installed" ]; }; then
  if [ "$1" = guard ] && printf '%s' "$input" | grep -q '"tool_name" *: *"Bash"' && ! printf '%s' "$input" | grep -q 'git[^"]*commit'; then
    exit 0
  fi
  if [ -n "$refusal" ]; then
    echo "$refusal" >&2
    exit 2
  fi
  have="the global warden is ${installed:-not on PATH}"
  echo "The Warden plugin $version needs the global warden $version or later, and $have. Next action: run npm install -g git+https://github.com/RyanAmundson/warden.git#v$version." >&2
  exit 2
fi
case $1 in
  guard) printf '%s' "$input" | warden guard ;;
  check) printf '%s' "$input" | warden check --format agent --hook claude ;;
  *) echo "usage: warden.sh guard|check" >&2; exit 2 ;;
esac
code=$?
[ "$code" -eq 0 ] || [ "$code" -eq 2 ] && exit "$code"
echo "warden exited $code. Next action: run warden doctor in $root and fix what it names." >&2
exit 2
