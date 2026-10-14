// Variant "v2" of the "landing" redirect experiment. Visitors assigned to v2
// see this page at "/" via an invisible middleware rewrite.
export default function HomeV2() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ fontSize: 48 }}>Landing v2</h1>
      <p>Served by the middleware rewrite. The URL still says /.</p>
    </main>
  );
}
