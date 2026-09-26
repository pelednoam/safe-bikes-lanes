#!/usr/bin/env bash
# Check the built APK is what it claims to be, from the APK itself rather than
# from the build files that were meant to produce it.
#
#   check_apk.sh <apk> <expected versionCode>
#
# Each check is a mistake that shipped or nearly did: debug builds released as
# the real thing (debuggable, so WebView remote debugging on), versionCode 1 on
# every build, the storage open to adb backup, a plugin missing because
# `cap sync` did not run, and a background-location permission never used.
set -euo pipefail

apk=$1
want_code=$2

build_tools=$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)
aapt2="${build_tools}aapt2"
fail() { echo "::error::$*"; exit 1; }

badging=$("$aapt2" dump badging "$apk")
code=$(sed -n "s/^package: .*versionCode='\([0-9]*\)'.*/\1/p" <<<"$badging")
name=$(sed -n "s/^package: .*versionName='\([^']*\)'.*/\1/p" <<<"$badging")
echo "versionCode $code, versionName $name"
[ "$code" = "$want_code" ] || fail "versionCode is $code, expected $want_code"

if grep -q "application-debuggable" <<<"$badging"; then
  fail "the APK is debuggable — Capacitor turns WebView remote debugging on for it"
fi

manifest=$("$aapt2" dump xmltree "$apk" --file AndroidManifest.xml)
grep -Eq 'allowBackup\(0x[0-9a-f]+\)=(false|0x0)' <<<"$manifest" ||
  fail "allowBackup is not false: rides and saved places could be backed up off the phone"

perms=$("$aapt2" dump permissions "$apk")
grep -q "POST_NOTIFICATIONS" <<<"$perms" ||
  fail "POST_NOTIFICATIONS is missing: the ride's notification would be hidden on Android 13+"
if grep -q "ACCESS_BACKGROUND_LOCATION" <<<"$perms"; then
  fail "ACCESS_BACKGROUND_LOCATION is back; the ride's foreground service makes it unnecessary"
fi

# The plugins Capacitor will register, as `cap sync` wrote them into the APK.
plugins=$(unzip -p "$apk" assets/capacitor.plugins.json)
for plugin in com.capacitorjs.plugins.app.AppPlugin \
  com.equimaps.capacitor_background_geolocation.BackgroundGeolocation; do
  grep -q "$plugin" <<<"$plugins" || fail "$plugin is not in the APK — did cap sync run?"
done
if grep -q "capacitorjs.plugins.browser" <<<"$plugins"; then
  fail "the unused Browser plugin is back in the APK"
fi

echo "APK checks passed"
