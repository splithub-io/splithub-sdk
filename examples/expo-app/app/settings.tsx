import { useIdentify } from '@splithub/react-native';
import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function Settings() {
  const identify = useIdentify();
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Pressable onPress={() => identify('user_42', { plan: 'pro' })}>
        <Text style={styles.link}>Sign in as user_42</Text>
      </Pressable>
      <Pressable onPress={() => identify(null)}>
        <Text style={styles.link}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  link: { color: '#2563eb', textAlign: 'center', fontSize: 16 },
});
