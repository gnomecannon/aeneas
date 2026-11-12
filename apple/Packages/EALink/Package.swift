// swift-tools-version: 6.0
import PackageDescription

// The Direct link (iroh) for the iPhone, iPad and Mac apps and the share extension: requests to a hub saved as
// iroh://<hub key> go over an encrypted iroh connection to that key (hub/src/link.ts). iroh has no watchOS build, so
// this stays out of EACore; the Watch reaches a hub through the iPhone.
let package = Package(
    name: "EALink",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "EALink", targets: ["EALink"])
    ],
    dependencies: [
        .package(path: "../EACore"),
        // n0's Swift binding for iroh (MIT or Apache-2.0); its prebuilt framework is checked by Swift Package Manager
        // against the checksum pinned in that release's Package.swift.
        .package(url: "https://github.com/n0-computer/iroh-ffi", exact: "1.2.0")
    ],
    targets: [
        .target(
            name: "EALink",
            dependencies: ["EACore", .product(name: "IrohLib", package: "iroh-ffi")],
            path: "Sources/EALink",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("SystemConfiguration"), .linkedFramework("CoreWLAN", .when(platforms: [.macOS]))]
        ),
        .testTarget(
            name: "EALinkTests",
            dependencies: ["EALink"],
            path: "Tests/EALinkTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
