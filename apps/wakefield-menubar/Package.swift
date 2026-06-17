// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WakefieldMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "WakefieldMenuBar", targets: ["WakefieldMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "WakefieldMenuBar",
            path: "Sources/WakefieldMenuBar"
        )
    ]
)
