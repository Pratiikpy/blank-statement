#!/usr/bin/env bash
# Upscale the recording to 4K.
#
# Run this from bash, not from node. Spawning ffmpeg from node on Windows
# mangles the quoting of the -vf filter and the transcode dies with an opaque
# status code, which is why record.mjs writes results.json first and stops.
#
# Playwright renders the webm at the native viewport (1600x900). A lanczos
# upscale to 3840x2160 keeps text crisp; scaling in the browser instead does
# not, because recordVideo ignores deviceScaleFactor and CSS zoom.
set -u
OUT="${OUT:-demo/out}"

webm="$(ls -t "$OUT"/*.webm 2>/dev/null | head -1)"
if [ -z "$webm" ]; then
  echo "no .webm in $OUT — run: node demo/record.mjs"
  exit 1
fi
echo "source: $webm"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration \
  -of default=noprint_wrappers=1 "$webm" 2>/dev/null

mp4="$OUT/blank-statement-4k.mp4"
ffmpeg -y -loglevel error -stats -i "$webm" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -vf "scale=3840:2160:flags=lanczos,format=yuv420p" \
  -movflags +faststart -r 30 "$mp4"

echo
echo "wrote $mp4"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration \
  -of default=noprint_wrappers=1 "$mp4" 2>/dev/null
ls -la "$mp4" | awk '{print $5" bytes"}'
