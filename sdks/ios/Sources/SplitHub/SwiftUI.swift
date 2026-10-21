#if canImport(SwiftUI)
import SwiftUI

/// Shows the content for the user's variant and records the exposure when it appears.
///
/// ```swift
/// SplitHubExperiment("checkout-button") { variant in
///     if variant == "green" { GreenButton() } else { BlueButton() }
/// }
/// ```
///
/// On the very first launch the content gets `default` until the dashboard's experiments
/// arrive (at most `Options.waitMs`), then the user's variant.
public struct SplitHubExperiment<Content: View>: View {
    private let id: String
    private let fallback: String
    private let content: (String) -> Content
    @ObservedObject private var client: SplitHub

    public init(_ id: String, default fallback: String = "control", client: SplitHub = .shared, @ViewBuilder content: @escaping (String) -> Content) {
        self.id = id
        self.fallback = fallback
        self.content = content
        self.client = client
    }

    public var body: some View {
        content(client.peekVariant(id, default: fallback))
            .onAppear { client.exposure(id) }
    }
}

private struct SplitHubScreenModifier: ViewModifier {
    let name: String
    let props: [String: JSONValue]?

    func body(content: Content) -> some View {
        content.onAppear { SplitHub.screen(name, props: props) }
    }
}

public extension View {
    /// Reports a screen view each time this view appears: a page `/<name>` for your analytics property.
    func splithubScreen(_ name: String, props: [String: JSONValue]? = nil) -> some View {
        modifier(SplitHubScreenModifier(name: name, props: props))
    }
}
#endif
