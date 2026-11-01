import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'nl.satvey.inspect',
  appName: 'Satvey Inspect',
  webDir: 'dist',
  plugins: {
    CapacitorHttp: { enabled: true },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: true,
      androidIsEncryption: true,
    },
  },
};
export default config;
