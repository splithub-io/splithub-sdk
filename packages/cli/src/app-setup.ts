// Apps (React Native / Expo, native iOS and Android) in `splithub init`, `analytics connect` and `doctor`.
//
// React Native / Expo: install @splithub/react-native and wrap the app entry (App.tsx, or app/_layout.tsx with
// Expo Router) in <SplitHubProvider>, with the screen tracker for the navigation library in use. The entry is
// rewritten with the TypeScript compiler (the project's own, else the CLI's); without it, or when the entry has
// a shape we do not recognise, the snippet is printed instead. Native projects get install lines only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type * as TS from 'typescript';
import type { AppKind, ProjectInfo } from './project';

export const RN_PACKAGE = '@splithub/react-native';
export const ASYNC_STORAGE = '@react-native-async-storage/async-storage';

/** How screens are reported: a tracker component per navigation library, or `useScreen()` by hand. */
export type ScreenTracking = 'expo-router' | 'react-navigation' | null;

const TRACKERS: Record<Exclude<ScreenTracking, null>, { name: string }> = {
  'expo-router': { name: 'ExpoRouterScreens' },
  'react-navigation': { name: 'NavigationScreens' },
};

const providerImport = (tracker: { name: string } | null) => `import { SplitHubProvider${tracker ? `, ${tracker.name}` : ''} } from '${RN_PACKAGE}';`;

export function screenTracking(project: Pick<ProjectInfo, 'expoRouter' | 'reactNavigation'>): ScreenTracking {
  return project.expoRouter ? 'expo-router' : project.reactNavigation ? 'react-navigation' : null;
}

export const isReactNativeApp = (app: AppKind | null): app is 'expo' | 'react-native' => app === 'expo' || app === 'react-native';
export const isNativeApp = (app: AppKind | null): app is 'ios' | 'android' => app === 'ios' || app === 'android';

/** npm packages for a React Native app; Expo installs the storage module with `expo install` (the version matching its SDK). */
export function appPackages(project: Pick<ProjectInfo, 'app' | 'deps'>): { runtime: string[]; expo: string[] } {
  const storage = project.deps[ASYNC_STORAGE] ? [] : [ASYNC_STORAGE];
  if (project.app === 'expo') return { runtime: [RN_PACKAGE, '@splithub/core'], expo: storage };
  return { runtime: [RN_PACKAGE, '@splithub/core', ...storage], expo: [] };
}

/** The file that renders the whole app: the root layout with Expo Router, else App.tsx. */
export function findAppEntry(root: string, expoRouter: boolean): string | null {
  const names = expoRouter ? ['app/_layout', 'src/app/_layout'] : ['App', 'src/App', 'app/App'];
  for (const name of names) {
    for (const ext of ['.tsx', '.jsx', '.js', '.ts']) {
      const file = join(root, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

export interface EntryPatch {
  /** The new source; null when nothing changes. */
  source: string | null;
  status: 'added' | 'already' | 'manual';
  /** Whether the screen tracker was placed (false: add it by hand, see the snippet). */
  screens: boolean;
  reason?: string;
}

/** The provider snippet to paste when the entry cannot be rewritten. */
export function appProviderSnippet(configImport: string, screens: ScreenTracking): string {
  const tracker = screens ? TRACKERS[screens] : null;
  const imports = [providerImport(tracker), `import config from '${configImport}';`];
  if (screens === 'expo-router')
    return `// app/_layout.tsx\n${imports.join('\n')}\n\n<SplitHubProvider config={config}>\n  <ExpoRouterScreens />\n  <Stack />\n</SplitHubProvider>`;
  if (screens === 'react-navigation')
    return `// App.tsx\n${imports.join('\n')}\n\n<SplitHubProvider config={config}>\n  <NavigationContainer>\n    <NavigationScreens />\n    {/* your navigators */}\n  </NavigationContainer>\n</SplitHubProvider>`;
  return `// App.tsx\n${imports.join('\n')}\n\n<SplitHubProvider config={config}><App /></SplitHubProvider>\n// screens: useScreen('Home') in each screen (from ${RN_PACKAGE})`;
}

function scriptKind(ts: typeof TS, file: string): TS.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

type Fn = TS.FunctionDeclaration | TS.FunctionExpression | TS.ArrowFunction;

/** The component behind `export default`: a function, `export default App`, or a wrapper call like `Sentry.wrap(App)`. */
function defaultComponent(ts: typeof TS, sf: TS.SourceFile): Fn | null {
  const byName = (name: string): Fn | null => {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
        }
      }
    }
    return null;
  };
  const fromExpr = (e: TS.Expression): Fn | null => {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isIdentifier(e)) return byName(e.text);
    if (ts.isCallExpression(e) && e.arguments[0]) return fromExpr(e.arguments[0]);
    if (ts.isParenthesizedExpression(e)) return fromExpr(e.expression);
    return null;
  };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return st;
    if (ts.isExportAssignment(st) && !st.isExportEquals) return fromExpr(st.expression);
  }
  return null;
}

const isJsx = (ts: typeof TS, n: TS.Node) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);

function indentAt(src: string, pos: number): string {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart))![0];
}

/** Move lines 2..n of `text` by the difference between where its first line starts and where it will start. */
function shift(text: string, fromCol: number, toCol: number): string {
  const d = toCol - fromCol;
  if (d === 0) return text;
  return text
    .split('\n')
    .map((line, i) => (i === 0 || !line.trim() ? line : d > 0 ? ' '.repeat(d) + line : line.replace(new RegExp(`^[ \\t]{0,${-d}}`), '')))
    .join('\n');
}

/**
 * Wraps what the entry's default component returns in <SplitHubProvider config={config}> and adds the imports.
 * Pure: the caller reads and writes the file.
 */
export function patchAppEntry(ts: typeof TS, file: string, src: string, opts: { configImport: string; screens: ScreenTracking }): EntryPatch {
  if (/<SplitHubProvider\b/.test(src)) return { source: null, status: 'already', screens: true };
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
  const fn = defaultComponent(ts, sf);
  if (!fn?.body) return { source: null, status: 'manual', screens: false, reason: 'no default-exported component' };

  // The returned JSX: the last top-level `return <…>` of a block body, or an arrow's expression body.
  let outer: TS.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const ret = [...fn.body.statements].reverse().find((s): s is TS.ReturnStatement => ts.isReturnStatement(s) && Boolean(s.expression));
    outer = ret?.expression;
  } else outer = fn.body;
  let inner = outer;
  while (inner && ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!outer || !inner || !isJsx(ts, inner)) return { source: null, status: 'manual', screens: false, reason: 'the component does not return JSX directly' };

  const tracker = opts.screens ? TRACKERS[opts.screens] : null;
  const start = inner.getStart(sf);
  let body = src.slice(start, inner.end);
  let screensPlaced = !tracker;
  let trackerLine = '';
  if (tracker && opts.screens === 'react-navigation') {
    // Inside <NavigationContainer>, where its ref context is available.
    let container: TS.JsxElement | undefined;
    const find = (n: TS.Node): void => {
      if (!container && ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'NavigationContainer') container = n;
      else ts.forEachChild(n, find);
    };
    find(inner);
    if (container) {
      const at = container.openingElement.end - start;
      const firstChild = container.children.find((ch) => !(ts.isJsxText(ch) && ch.containsOnlyTriviaWhiteSpaces));
      const childIndent = firstChild ? indentAt(src, firstChild.getStart(sf)) : indentAt(src, container.getStart(sf)) + '  ';
      body = `${body.slice(0, at)}\n${childIndent}<${tracker.name} />${body.slice(at)}`;
      screensPlaced = true;
    }
  } else if (tracker) {
    trackerLine = `<${tracker.name} />`;
    screensPlaced = true;
  }

  const configName = /\bconfig\b/.test(src) ? 'splithubConfig' : 'config';
  const base = indentAt(src, outer.getStart(sf));
  const col = start - (src.lastIndexOf('\n', start - 1) + 1);
  const inside = base + '    ';
  const wrapped = [
    '(',
    `${base}  <SplitHubProvider config={${configName}}>`,
    ...(trackerLine ? [`${inside}${trackerLine}`] : []),
    `${inside}${shift(body, col, inside.length)}`,
    `${base}  </SplitHubProvider>`,
    `${base})`,
  ].join('\n');
  let out = src.slice(0, outer.getStart(sf)) + wrapped + src.slice(outer.end);

  const imports = [providerImport(tracker && screensPlaced ? tracker : null), `import ${configName} from '${opts.configImport}';`].join('\n');
  const lastImport = [...sf.statements].filter(ts.isImportDeclaration).pop();
  if (lastImport) out = out.slice(0, lastImport.end) + '\n' + imports + out.slice(lastImport.end);
  else out = imports + '\n\n' + out;
  return { source: out, status: 'added', screens: screensPlaced };
}

// ---------------------------------------------------------------------------
// Native SDKs: install lines and a quick start, no patching.
// ---------------------------------------------------------------------------

// The same values as sdks/ios/README.md, sdks/android/README.md and the dashboard's install tabs.
export const IOS_PACKAGE_URL = 'https://github.com/splithub-io/splithub-sdk';
export const ANDROID_ARTIFACT = 'io.splithub:splithub';
export const ANDROID_COMPOSE_ARTIFACT = 'io.splithub:splithub-compose';
export const NATIVE_SDK_VERSION = '0.5.0';

export function nativeSetup(app: 'ios' | 'android', publicKey: string | null, property: string | null = null): { install: string; quickStart: string } {
  const key = publicKey ?? 'pk_…';
  const prop = property ?? 'sh-…';
  if (app === 'ios')
    return {
      install: `// Xcode: File → Add Package Dependencies → ${IOS_PACKAGE_URL}, then add SplitHub to the target\n.package(url: "${IOS_PACKAGE_URL}", from: "${NATIVE_SDK_VERSION}")`,
      quickStart: `import SplitHub\n\nSplitHub.start(publicKey: "${key}", property: "${prop}") // once, at launch\nlet cta = SplitHub.variant("hero-cta")               // "control", "bold", ...\nSplitHub.screen("Settings")                          // each screen\nSplitHub.track("Signup")                             // any event; a goal when marked as one`,
    };
  return {
    install: `// app/build.gradle.kts\nimplementation("${ANDROID_ARTIFACT}:${NATIVE_SDK_VERSION}")\nimplementation("${ANDROID_COMPOSE_ARTIFACT}:${NATIVE_SDK_VERSION}") // optional: Experiment(id) { variant -> }, TrackScreen(name)`,
    quickStart: `import io.splithub.SplitHub\n\nSplitHub.start(this, "${key}", property = "${prop}")  // once, in Application.onCreate\nval cta = SplitHub.variant("hero-cta")               // "control", "bold", ...\nSplitHub.screen("Settings")                          // each screen\nSplitHub.track("Signup")                             // any event; a goal when marked as one`,
  };
}

/** Whether the native project already depends on the SDK (Package.swift, Podfile, project.pbxproj, Gradle files). */
export function nativeSdkInstalled(root: string, app: 'ios' | 'android', read: (file: string) => string | null): boolean {
  const files = app === 'ios' ? ['Package.swift', 'Podfile', 'Package.resolved'] : ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts', 'gradle/libs.versions.toml'];
  const needle = app === 'ios' ? /splithub/i : /io\.splithub/;
  return files.some((f) => needle.test(read(join(root, f)) ?? ''));
}
