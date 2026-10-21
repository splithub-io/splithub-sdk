import { Experiment, Variant, useTrack } from '@splithub/react-native';
import { Link, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// `welcome` is made in the dashboard (variants `control` and `short`, goal `Get Started`).
// Until it runs, everyone sees the control.
export default function Home() {
  const track = useTrack();
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Home' }} />
      <Experiment id="welcome">
        <Variant name="control">
          <Text style={styles.title}>Welcome to the example shop. Browse, save, check out in two taps.</Text>
        </Variant>
        <Variant name="short">
          <Text style={styles.title}>Shop in two taps.</Text>
        </Variant>
      </Experiment>
      <Pressable style={styles.button} onPress={() => track('Get Started')}>
        <Text style={styles.buttonText}>Get started</Text>
      </Pressable>
      <Link href="/settings" style={styles.link}>
        Settings
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '600' },
  button: { backgroundColor: '#111827', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { color: '#2563eb', textAlign: 'center', fontSize: 16 },
});
