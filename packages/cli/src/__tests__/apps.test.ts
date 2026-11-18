// Apps in the CLI: project detection, the entry rewrite, native install lines, doctor checks,
// the retention table, and `init` end to end on an Expo Router and a native iOS project.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPackages, findAppEntry, NATIVE_SDK_VERSION, nativeSdkInstalled, nativeSetup, patchAppEntry, screenTracking } from '../app-setup';
import { retentionRows } from '../commands/analytics-reports';
import { propertyKind } from '../commands/analytics';
import { trackSnippets } from '../commands/connect';
import { appChecks, type Level } from '../commands/doctor';
import { EXPERIMENT_BY, EXPERIMENT_FILTERS } from '../commands/experiment-reports';
import { ANALYTICS_BY } from '../commands/analytics';
import { detectApp, detectProject } from '../project';
import { configTemplate } from '../templates';

const cli = resolve(__dirname, '../../dist/index.js');
const root = resolve(__dirname, '../../.tmp-apps');

function dir(name: string, files: Record<string, string>): string {
  const d = join(root, `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  mkdirSync(d, { recursive: true });
  return d;
}
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'shop', dependencies: deps });

beforeAll(() => {
  if (!existsSync(cli)) execFileSync(process.execPath, [resolve(__dirname, '../../../../node_modules/tsup/dist/cli-default.js')], { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('detection', () => {
  it('tells React Native, Expo, iOS, Android and websites apart', () => {
    expect(detectApp(dir('rn', {}), { 'react-native': '0.76.0' })).toBe('react-native');
    expect(detectApp(dir('expo', {}), { expo: '52.0.0', 'react-native': '0.76.0' })).toBe('expo');
    expect(detectApp(dir('ios', { 'Podfile': "platform :ios, '15.0'\n" }), {})).toBe('ios');
    expect(detectApp(dir('swift', { 'Package.swift': '// swift-tools-version:5.9\n' }), {})).toBe('ios');
    expect(detectApp(dir('xcode', { 'Shop.xcodeproj/project.pbxproj': '' }), {})).toBe('ios');
    expect(detectApp(dir('gradle', { 'app/build.gradle.kts': 'plugins { alias(libs.plugins.android.application) }\n' }), {})).toBe('android');
    expect(detectApp(dir('groovy', { 'app/build.gradle': "apply plugin: 'com.android.application'\n" }), {})).toBe('android');
    expect(detectApp(dir('lib', { 'build.gradle.kts': 'plugins { id("com.android.library") }\n' }), {})).toBeNull();
    expect(detectApp(dir('web', {}), { react: '18.3.1' })).toBeNull();
  });

  it('reads the navigation library and the packages to install', () => {
    const d = dir('expo-router', { 'package.json': pkg({ expo: '52.0.0', 'expo-router': '4.0.0', 'react-native': '0.76.0' }), 'app/_layout.tsx': '' });
    const project = detectProject(d);
    expect(project).toMatchObject({ app: 'expo', expoRouter: true });
    expect(screenTracking(project)).toBe('expo-router');
    expect(findAppEntry(d, true)).toBe(join(d, 'app/_layout.tsx'));
    expect(appPackages(project)).toEqual({ runtime: ['@splithub/react-native', '@splithub/core'], expo: ['@react-native-async-storage/async-storage'] });
    expect(appPackages({ app: 'react-native', deps: { '@react-native-async-storage/async-storage': '2.0.0' } })).toEqual({ runtime: ['@splithub/react-native', '@splithub/core'], expo: [] });
    expect(screenTracking({ expoRouter: false, reactNavigation: true })).toBe('react-navigation');
  });
});

describe('patchAppEntry', () => {
  it('wraps the Expo Router root layout and tracks screens', () => {
    const src = `import { Stack } from 'expo-router';\n\nexport default function RootLayout() {\n  return <Stack />;\n}\n`;
    const out = patchAppEntry(ts, '_layout.tsx', src, { configImport: '../splithub.config', screens: 'expo-router' });
    expect(out.status).toBe('added');
    expect(out.source).toBe(
      `import { Stack } from 'expo-router';\nimport { SplitHubProvider, ExpoRouterScreens } from '@splithub/react-native';\nimport config from '../splithub.config';\n\nexport default function RootLayout() {\n  return (\n    <SplitHubProvider config={config}>\n      <ExpoRouterScreens />\n      <Stack />\n    </SplitHubProvider>\n  );\n}\n`
    );
    // Run again: nothing changes.
    expect(patchAppEntry(ts, '_layout.tsx', out.source!, { configImport: '../splithub.config', screens: 'expo-router' })).toMatchObject({ status: 'already', source: null });
  });

  it('puts the navigation tracker inside <NavigationContainer> and keeps the indentation', () => {
    const src = [
      `import { NavigationContainer } from '@react-navigation/native';`,
      `import config from './config';`,
      ``,
      `const App = () => {`,
      `  return (`,
      `    <NavigationContainer>`,
      `      <Tabs />`,
      `    </NavigationContainer>`,
      `  );`,
      `};`,
      ``,
      `export default App;`,
      ``,
    ].join('\n');
    const out = patchAppEntry(ts, 'App.tsx', src, { configImport: './splithub.config', screens: 'react-navigation' });
    expect(out).toMatchObject({ status: 'added', screens: true });
    // The app already has a `config`: ours gets another name.
    expect(out.source).toContain(`import splithubConfig from './splithub.config';`);
    expect(out.source).toContain(`import { SplitHubProvider, NavigationScreens } from '@splithub/react-native';`);
    expect(out.source).toContain(
      ['  return (', '    <SplitHubProvider config={splithubConfig}>', '      <NavigationContainer>', '        <NavigationScreens />', '        <Tabs />', '      </NavigationContainer>', '    </SplitHubProvider>', '  );'].join('\n')
    );
    const parsed = ts.createSourceFile('App.tsx', out.source!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) as unknown as { parseDiagnostics: unknown[] };
    expect(parsed.parseDiagnostics).toHaveLength(0);
  });

  it('follows export default through a wrapper call, and gives up on what it does not know', () => {
    const wrapped = `function App() {\n  return (\n    <View>\n      <Text>Hi</Text>\n    </View>\n  );\n}\nexport default Sentry.wrap(App);\n`;
    const out = patchAppEntry(ts, 'App.js', wrapped, { configImport: './splithub.config', screens: null });
    expect(out.status).toBe('added');
    expect(out.source!.startsWith(`import { SplitHubProvider } from '@splithub/react-native';\nimport config from './splithub.config';\n\nfunction App()`)).toBe(true);
    expect(out.source).toContain('    <SplitHubProvider config={config}>\n      <View>\n        <Text>Hi</Text>\n      </View>\n    </SplitHubProvider>');
    expect(patchAppEntry(ts, 'App.tsx', `export default function App() {\n  return null;\n}\n`, { configImport: './c', screens: null })).toMatchObject({ status: 'manual', source: null });
    expect(patchAppEntry(ts, 'App.tsx', `export const x = 1;\n`, { configImport: './c', screens: null })).toMatchObject({ status: 'manual' });
  });
});

describe('native and doctor', () => {
  it('prints install lines and finds the SDK in build files', () => {
    expect(nativeSetup('ios', 'pk_live_1').quickStart).toContain('SplitHub.start(publicKey: "pk_live_1", property: "sh-…")');
    expect(nativeSetup('ios', null).install).toContain(`.package(url: "https://github.com/splithub-io/splithub-sdk", from: "${NATIVE_SDK_VERSION}")`);
    expect(nativeSetup('android', 'pk_live_1', 'sh-x1h78w').quickStart).toContain('SplitHub.start(this, "pk_live_1", property = "sh-x1h78w")');
    expect(nativeSetup('android', null).install).toContain('implementation("io.splithub:splithub:');
    const files: Record<string, string> = { 'Package.swift': '.package(url: "https://github.com/splithub-io/splithub-sdk", from: "0.4.3")' };
    const read = (f: string) => Object.entries(files).find(([k]) => f.endsWith(k))?.[1] ?? null;
    expect(nativeSdkInstalled('/x', 'ios', read)).toBe(true);
    expect(nativeSdkInstalled('/x', 'android', read)).toBe(false);
  });

  it('checks the package and warns that app configs are frozen', () => {
    const checks: Array<[Level, string]> = [];
    appChecks({ app: 'expo', deps: {} }, { experiments: [{ key: 'old', kind: 'redirect' } as never], storage: { mode: 'cloud' } as never }, (l, m) => checks.push([l, m]));
    expect(checks.filter(([l]) => l === 'error').map(([, m]) => m)).toEqual([expect.stringContaining('@splithub/react-native is not in package.json'), expect.stringContaining('npx expo install @react-native-async-storage/async-storage')]);
    expect(checks.some(([l, m]) => l === 'warn' && /redirect/.test(m))).toBe(true);
    expect(checks.some(([l, m]) => l === 'warn' && /frozen into the binary/.test(m))).toBe(true);
  });
});

describe('reports and snippets', () => {
  it('builds the cohort table from the answer, old field names too', () => {
    expect(retentionRows({ cohorts: [{ start: '2026-10-05', users: 200, retained: [200, 50] }, { start: '2026-10-12', users: 100, retained: [100] }] })).toEqual({
      periods: 2,
      rows: [
        ['2026-10-05', '200', '100.0%', '25.0%'],
        ['2026-10-12', '100', '100.0%', ''],
      ],
    });
    expect(retentionRows({ cohorts: [{ cohort: '2026-10-05', size: 10, returned: [10, 3] }] }).rows[0]).toEqual(['2026-10-05', '10', '100.0%', '30.0%']);
  });

  it('accepts platform and app_version wherever device is accepted', () => {
    for (const list of [EXPERIMENT_BY, EXPERIMENT_FILTERS, ANALYTICS_BY] as ReadonlyArray<readonly string[]>) expect(list).toEqual(expect.arrayContaining(['device', 'platform', 'app_version']));
  });

  it('picks the property kind and the React Native imports', () => {
    expect(propertyKind({}, 'expo')).toBe('app');
    expect(propertyKind({}, null)).toBe('site');
    expect(propertyKind({ kind: 'site' }, 'ios')).toBe('site');
    const s = trackSnippets('unknown', 'sh-1', 'pk_1', 'expo');
    expect(s.track).toContain(`from '@splithub/react-native'`);
    expect(s.screen).toContain('useScreen(');
    expect(s.script).toBe('');
    expect(configTemplate('shop', 'cloud', undefined, { app: true })).toContain('process.env.EXPO_PUBLIC_SPLITHUB_KEY');
  });
});

describe('init in apps', () => {
  const run = (d: string, args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: d, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API: 'http://127.0.0.1:9', SPLITHUB_API_KEY: '' } }).trim().split('\n').pop()!);

  it('Expo Router: cloud by default, packages listed, the layout wrapped', () => {
    const d = dir('init-expo', {
      'package.json': pkg({ expo: '52.0.0', 'expo-router': '4.0.0', 'react-native': '0.76.0' }),
      'app/_layout.tsx': `import { Stack } from 'expo-router';\n\nexport default function RootLayout() {\n  return <Stack />;\n}\n`,
    });
    const out = run(d, ['init', '--yes', '--no-install', '--no-login', '--no-mcp']);
    expect(out).toMatchObject({ mode: 'cloud', app: { kind: 'expo', screens: 'expo-router', entry: { file: 'app/_layout.tsx', status: 'added', screens: true } }, nextStep: null });
    expect(out.installCommands).toEqual(['npm install @splithub/react-native @splithub/core', 'npx expo install @react-native-async-storage/async-storage', 'npm install -D splithub']);
    const layout = readFileSync(join(d, 'app/_layout.tsx'), 'utf8');
    expect(layout).toContain(`import config from '../splithub.config';`);
    expect(layout).toContain('<ExpoRouterScreens />');
    expect(readFileSync(join(d, 'splithub.config.ts'), 'utf8')).toContain('EXPO_PUBLIC_SPLITHUB_KEY');
  });

  it('native iOS: no config file, install lines and a quick start', () => {
    const d = dir('init-ios', { Podfile: "platform :ios, '15.0'\n" });
    const out = run(d, ['init', '--mode', 'self', '--yes', '--no-install', '--no-login', '--no-mcp']);
    expect(out).toMatchObject({ mode: 'cloud', app: { kind: 'ios', entry: null }, installCommands: [] });
    expect(out.app.install).toContain('.package(url:');
    expect(out.notes[0]).toMatch(/SplitHub Cloud/);
    expect(existsSync(join(d, 'splithub.config.ts'))).toBe(false);
  });
});
