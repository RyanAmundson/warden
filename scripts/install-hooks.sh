#!/bin/sh
set -eu
if [ $# -ne 1 ]; then
  echo "usage: install-hooks.sh <trusted-release-tag>" >&2
  exit 2
fi
tag=$1
root=$(git rev-parse --show-toplevel)
if ! git -C "$root" cat-file -e "$tag:scripts/self-check.sh" 2>/dev/null; then
  echo "install-hooks: tag $tag does not exist or does not contain scripts/self-check.sh" >&2
  exit 2
fi
hook=$(git -C "$root" rev-parse --path-format=absolute --git-path hooks/pre-commit)
mkdir -p "$(dirname "$hook")"
rm -f "$hook"
cat > "$hook" <<HOOK
#!/bin/sh
tag=$tag
root=\$(git rev-parse --show-toplevel)
script=\$(mktemp "\${TMPDIR:-/tmp}/warden-self-check-script.XXXXXX")
trap 'rm -f "\$script"' EXIT
git -C "\$root" show "\$tag:scripts/self-check.sh" > "\$script" || exit 1
cd "\$root"
sh "\$script" "\$tag"
HOOK
chmod +x "$hook"
