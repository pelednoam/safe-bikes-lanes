import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pelednoam.safebikes",
  appName: "Family Bike Router",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SystemBars: {
      // The app's own default theme, which is light, rather than "DEFAULT" —
      // the phone's theme — which drew white status-bar icons over the
      // near-white map on phones in system dark mode. The page sets the style
      // from its own dark-mode switch once it loads (setSystemBarsDark); this
      // covers the moment before that.
      style: "LIGHT",
    },
  },
};

export default config;
