#!/usr/bin/env bash
# Regenerates src/ci-icons.mjs: GitLab's pipeline/job status icons (an outlined
# circle with a check, a cross, an exclamation mark, ...) as embedded PNG data
# URIs, in the colours of the Pipeline and Status rows of the cards: teal
# passed, red failed, blue running, orange warning, gray for the rest. Needs npm,
# tar and ImageMagick (with the librsvg delegate).
#
# Usage: scripts/gen-ci-icons.sh [VERSION]   (default: the version of
# gitlab-icons-small.mjs, 3.174.0)

set -euo pipefail

version="${1:-3.174.0}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack --silent "@gitlab/svgs@${version}" >/dev/null 2>&1 && mkdir pkg && tar -xzf ./*.tgz -C pkg)
src="$work/pkg/package/dist/sprite_icons"
[[ "$(jq -r .license "$work/pkg/package/package.json")" == "MIT" ]] || {
  echo "unexpected license" >&2
  exit 1
}

# key:glyph:colour:alt text (mid-tone colours that stay readable on a light and
# a dark Teams theme)
icons=(
  "success:status_success:#17a085:Passed"
  "failed:status_failed:#dd2b0e:Failed"
  "running:status_running:#2f7ed8:Running"
  "warning:status_warning:#d9820b:Warning"
  "pending:status_pending:#8a8a92:Pending"
  "preparing:status_preparing:#8a8a92:Preparing"
  "created:status_created:#8a8a92:Created"
  "scheduled:status_scheduled:#8a8a92:Scheduled"
  "canceled:status_canceled:#8a8a92:Canceled"
  "skipped:status_skipped:#8a8a92:Skipped"
  "manual:status_manual:#2f7ed8:Manual"
  "unknown:status_notfound:#8a8a92:Unknown"
)

# Drawn at 3x and shown at 16px (a small palette keeps each icon a few hundred
# bytes; a card is limited in size and a job card carries two of them).
px=16
s=3
out="$root/src/ci-icons.mjs"
{
  cat <<HEADER
// GitLab pipeline/job status icons as ${px}px images (3x PNG data URIs, generated
// by scripts/gen-ci-icons.sh, do not edit by hand). \`alt\` is the status in
// words for screen readers.
//
// The glyphs come from @gitlab/svgs ${version} (MIT, Copyright (c) 2011-present
// GitLab Inc.).

export const CI_STATUS_ICONS_PX = ${px};

export const CI_STATUS_ICONS = {
HEADER
  for spec in "${icons[@]}"; do
    IFS=: read -r key icon colour alt <<<"$spec"
    sed "s/<path /<path fill=\"${colour}\" /g; s/<circle /<circle fill=\"${colour}\" /g" "$src/${icon}.svg" >"$work/${key}.svg"
    magick -background none -density 1536 "$work/${key}.svg" -resize "$((px * s))x$((px * s))" \
      +dither -colors 16 -strip -define png:format=png8 -define png:compression-level=9 "$work/${key}.png"
    printf "  '%s': {\n    alt: '%s',\n    url:\n      'data:image/png;base64,%s',\n  },\n" "$key" "$alt" "$(base64 -w0 "$work/${key}.png")"
  done
  echo "};"
} >"$out"
echo "wrote $out"
