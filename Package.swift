// swift-tools-version:5.7
// The Swift package of sdks/ios, at the root so SwiftPM finds it by the repository URL.
import PackageDescription

let package = Package(
    name: "SplitHub",
    platforms: [.iOS(.v14), .macOS(.v11)],
    products: [
        .library(name: "SplitHub", targets: ["SplitHub"]),
    ],
    targets: [
        .target(name: "SplitHub", path: "sdks/ios/Sources/SplitHub"),
        .testTarget(
            name: "SplitHubTests",
            dependencies: ["SplitHub"],
            path: "sdks/ios/Tests/SplitHubTests",
            resources: [.copy("Resources/vectors.json")]
        ),
    ]
)
