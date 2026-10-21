// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "SplitHub",
    platforms: [.iOS(.v14), .macOS(.v11)],
    products: [
        .library(name: "SplitHub", targets: ["SplitHub"]),
    ],
    targets: [
        .target(name: "SplitHub", path: "Sources/SplitHub"),
        .testTarget(
            name: "SplitHubTests",
            dependencies: ["SplitHub"],
            path: "Tests/SplitHubTests",
            resources: [.copy("Resources/vectors.json")]
        ),
    ]
)
