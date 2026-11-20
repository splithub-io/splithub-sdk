import Foundation

/// The cloud's address can change after an app has shipped (splithub.io lapsed in November 2026
/// and took every hard-coded `go.splithub.io` with it). So the SDK keeps a short list instead of
/// one URL: the address the cloud last announced (`endpoint` in the overrides, kept in
/// UserDefaults), the endpoint passed to `start`, the default, and a backup on workers.dev, which
/// belongs to no domain that can lapse. Only a request with no answer moves to the next one.
/// A custom endpoint (a staging cloud, your own proxy) is used as written.
enum CloudEndpoints {
    static let key = "sh_endpoint"
    static let backups: [URL] = [URL(string: "https://splithub-go.adbro.workers.dev/v1/events")!]
    /// Earlier cloud addresses: an app that still passes one counts as on the cloud, and it is skipped.
    static let past: [String] = ["https://go.splithub.io/v1/events"]

    private static func trim(_ s: String) -> String {
        var v = s
        while v.hasSuffix("/") { v.removeLast() }
        return v
    }

    /// An `https://…/v1/events` URL, the only shape the cloud may announce.
    static func parse(_ value: String?) -> URL? {
        guard let v = value, v.count <= 200, let u = URL(string: v), u.scheme == "https", u.host != nil, u.query == nil, u.fragment == nil else { return nil }
        return trim(u.path).hasSuffix("/v1/events") ? u : nil
    }

    static func isCloud(_ endpoint: URL) -> Bool {
        let e = trim(endpoint.absoluteString)
        return ([SplitHub.defaultEndpoint] + backups).contains { trim($0.absoluteString) == e } || past.contains(e)
    }

    /// Addresses in the order to try them: announced, configured (unless a past one), default, backups.
    static func list(remembered: String?, configured: URL) -> [URL] {
        var out: [URL] = []
        let own: URL? = past.contains(trim(configured.absoluteString)) ? nil : configured
        for candidate in [parse(remembered), own, SplitHub.defaultEndpoint] + backups.map({ Optional($0) }) {
            guard let c = candidate else { continue }
            if !out.contains(where: { trim($0.absoluteString) == trim(c.absoluteString) }) { out.append(c) }
        }
        return out
    }
}
