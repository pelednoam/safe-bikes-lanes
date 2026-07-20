import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pelednoam.safebikes",
  appName: "Family Bike Router",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
};

export default config;
