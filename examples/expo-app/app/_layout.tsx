import { SplitHubProvider, useExpoRouterTracking } from '@splithub/react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

// Both come from the dashboard: the project's public key and the app's analytics property.
// No splithub.config.ts: every experiment made in the dashboard reaches the app through the cloud.
const publicKey = process.env.EXPO_PUBLIC_SPLITHUB_KEY ?? 'pk_your_key';
const property = process.env.EXPO_PUBLIC_SPLITHUB_PROPERTY;

function Screens() {
  // One screen view per route: `/`, `/settings`.
  useExpoRouterTracking();
  return <Stack />;
}

export default function RootLayout() {
  return (
    <SplitHubProvider publicKey={publicKey} project="expo-example" property={property}>
      <StatusBar style="auto" />
      <Screens />
    </SplitHubProvider>
  );
}
