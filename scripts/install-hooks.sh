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
if [ "$hook" = "$root/.warden/generated/hooks/pre-commit" ]; then
  echo "install-hooks: Git already uses the generated Warden hook at $hook" >&2
  exit 0
fi
mkdir -p "$(dirname "$hook")"
rm -f "$hook"
cat > "$hook" <<HOOK
#!/bin/sh
tag=$tag
(
  root=\$(git rev-parse --show-toplevel) || exit "\$?"
  script=\$(mktemp "\${TMPDIR:-/tmp}/warden-self-check-script.XXXXXX") || exit "\$?"
  trap 'rm -f "\$script"' EXIT
  git -C "\$root" show "\$tag:scripts/self-check.sh" > "\$script" || exit "\$?"
  cd "\$root" || exit "\$?"
  sh "\$script" "\$tag"
) || echo "Warden self-check exited \$?. The commit continues." >&2
(
  root=\$(git rev-parse --show-toplevel) || exit "\$?"
  generated="\$root/.warden/generated/hooks/pre-commit"
  # Source in a subshell so the generated hook still sees Git in PPID.
  . "\$generated"
) || echo "Warden's commit hook exited \$?. The commit continues." >&2
exit 0
HOOK
chmod +x "$hook"
