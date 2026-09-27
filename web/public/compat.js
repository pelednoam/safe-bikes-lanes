// Says so when this browser can't run the app, instead of leaving a blank map.
//
// Plain ES5 on purpose, and a classic script rather than a module: it has to
// parse on exactly the engines app.js can't. Firebase Test Lab's Android 9
// image ships Android System WebView 66 (2018). app.js needs ES2020 (?. and
// ??), so it never ran there, and the rider saw a white map and a panel of
// controls that did nothing. A real Android phone updates its WebView from the
// Play Store, so this mostly reaches phones without Google Play, or with
// updates turned off. For them, a blank screen is the worst answer.
//
// Two checks, neither on a timer (a slow network isn't an old browser):
//  - WebGL2, which the map (MapLibre 6) can't draw without;
//  - by DOMContentLoaded, app.js has run. Module scripts are deferred, and
//    the browser runs them before firing DOMContentLoaded, so if app.js hasn't
//    set window.__appStarted by then, it failed to load or to parse.
(function () {
  "use strict";

  function webgl2() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
    } catch (e) {
      return false;
    }
  }

  function show(reason) {
    var box = document.getElementById("compat");
    if (!box) return;
    var android = /Android/i.test(navigator.userAgent);
    var how = document.getElementById(android ? "compat-android" : "compat-browser");
    if (how) how.style.display = "block";
    box.setAttribute("data-reason", reason);
    box.style.display = "flex";
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.__appStarted) show("app-did-not-start");
    else if (!webgl2()) show("no-webgl2");
  });
})();
