// swift-tools-version: 6.0
import PackageDescription

// Tailscale inside Aeneas, for the iPhone, iPad and Mac apps: someone who chose Tailscale for their hub signs in to
// Tailscale here instead of installing the Tailscale app. Uses TailscaleKit from Tailscale's libtailscale (BSD-3-Clause),
// built from a pinned version by apple/scripts/build-tailscalekit.sh into TailscaleKit.xcframework next to this file
// (not kept in git: about 40 MB). No watchOS build; the Watch reaches the hub through the iPhone.
let package = Package(
    name: "EATailnet",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "EATailnet", targets: ["EATailnet"])
    ],
    dependencies: [
        .package(path: "../EACore")
    ],
    targets: [
        .binaryTarget(name: "TailscaleKit", path: "TailscaleKit.xcframework"),
        .target(
            name: "EATailnet",
            dependencies: ["EACore", "TailscaleKit"],
            path: "Sources/EATailnet",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
