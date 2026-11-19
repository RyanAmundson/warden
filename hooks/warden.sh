#!/bin/sh
root=$(pwd -P)
until [ -f "$root/.warden/config.yaml" ]; do
  [ "$root" = / ] && exit 0
  root=$(dirname "$root")
done
here=$(dirname "$0")
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$here/../package.json")
if ! command -v warden >/dev/null 2>&1; then
  echo "The Warden plugin runs the global warden command, which is not on PATH. Next action: run npm install -g git+https://github.com/RyanAmundson/warden.git#v$version, then retry." >&2
  exit 2
fi
case $1 in
  guard) warden guard ;;
  check) warden check --format agent --hook claude ;;
  *) echo "usage: warden.sh guard|check" >&2; exit 2 ;;
esac
code=$?
[ "$code" -eq 0 ] || [ "$code" -eq 2 ] && exit "$code"
echo "warden exited $code. Next action: run warden doctor in $root and fix what it names." >&2
exit 2
