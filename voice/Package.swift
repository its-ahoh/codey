// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CodeyVoice",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", from: "1.1.0"),
        // On-device streaming ASR (NVIDIA Nemotron via CoreML). Pinned to a
        // main-branch commit rather than a tag: the newest tag (0.15.6) has
        // the multilingual streaming manager but not its custom-vocabulary
        // biasing, which is what lets the user's dictionary keep working on
        // this engine. Move to `from:` once the next release ships it.
        .package(url: "https://github.com/FluidInference/FluidAudio", revision: "5c19d5e12320e22bbfb7a1877b089d2665a69add"),
    ],
    targets: [
        .executableTarget(
            name: "CodeyVoice",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/CodeyVoice",
            linkerSettings: [
                .linkedFramework("Cocoa"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("Foundation"),
            ]
        ),
    ]
)
