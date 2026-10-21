import Foundation

/// The `app` block of every batch: who sends it. The cloud reads device, OS and platform
/// from here instead of a user agent, and `id` (the bundle id) stands in for the origin.
struct AppInfo: Codable, Equatable {
    var platform: String
    var id: String?
    var version: String?
    var build: String?
    var os: String?
    var model: String?
    var device: String?
}

enum Device {
    /// `macos` for Mac apps and Mac Catalyst, `ios` otherwise.
    static var platform: String {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return "macos"
        #else
        return "ios"
        #endif
    }

    /// The hardware model: `iPhone15,2`, `iPad13,4`, `MacBookPro18,3`.
    static var model: String? {
        #if os(macOS)
        if let m = sysctlString("hw.model") { return m }
        #endif
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
            return simulated
        }
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw -> String in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
    }

    /// `mobile`, `tablet` or `desktop`, read from the model so it needs no main-thread UIKit call.
    static var deviceClass: String {
        #if os(macOS) || targetEnvironment(macCatalyst)
        return "desktop"
        #else
        if ProcessInfo.processInfo.isiOSAppOnMac { return "desktop" }
        let m = model ?? ""
        return m.hasPrefix("iPad") ? "tablet" : "mobile"
        #endif
    }

    /// `17.4.1`, `14.5`.
    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"
    }

    static func appInfo(bundle: Bundle = .main) -> AppInfo {
        let info = bundle.infoDictionary ?? [:]
        func clip(_ s: String?, _ max: Int) -> String? {
            guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
            return String(t.prefix(max))
        }
        return AppInfo(
            platform: platform,
            id: clip(bundle.bundleIdentifier, 128),
            version: clip(info["CFBundleShortVersionString"] as? String, 32),
            build: clip(info["CFBundleVersion"] as? String, 32),
            os: clip(osVersion, 32),
            model: clip(model, 64),
            device: deviceClass
        )
    }

    #if os(macOS)
    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        let s = String(cString: buffer)
        return s.isEmpty ? nil : s
    }
    #endif
}
