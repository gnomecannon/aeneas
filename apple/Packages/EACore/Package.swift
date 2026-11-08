// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EACore",
    platforms: [.iOS(.v18), .macOS(.v15), .watchOS(.v11)],
    products: [
        .library(name: "EACore", targets: ["EACore"])
    ],
    targets: [
        .target(
            name: "EACore",
            path: "Sources/EACore",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(
            name: "EACoreTests",
            dependencies: ["EACore"],
            path: "Tests/EACoreTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
