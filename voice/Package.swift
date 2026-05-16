// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodeyVoice",
    platforms: [.macOS(.v13)],
    targets: [
        // whisper.cpp — pre-built via CMake, headers + static libs in .build/deps/
        .systemLibrary(
            name: "WhisperBridge",
            pkgConfig: nil,
            providers: []
        ),
        .executableTarget(
            name: "CodeyVoice",
            dependencies: ["WhisperBridge"],
            path: "Sources/CodeyVoice",
            cSettings: [
                .headerSearchPath("../../.build/deps/include"),
            ],
            linkerSettings: [
                .unsafeFlags(["-L.build/deps/lib"]),
                .linkedFramework("Cocoa"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
            ]
        ),
    ]
)
