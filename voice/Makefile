# Codey Voice — build the Swift helper.
# Supports both cloud API transcription and on-device WhisperKit (CoreML / ANE).
# WhisperKit pulls model weights from HuggingFace on first use, so no models live in this tree.
.PHONY: all build run clean helper

all: build

# ── Swift build ─────────────────────────────────────────────────────
build:
	swift build -c release

# ── Run ─────────────────────────────────────────────────────────────
run: build
	@.build/release/CodeyVoice

# ── Package helper binary ──────────────────────────────────────────
APP_NAME := CodeyVoice

helper: build
	@echo "[voice] Staging $(APP_NAME) binary …"
	@cp .build/release/$(APP_NAME) ./$(APP_NAME)
	@echo "[voice] Built helper: ./$(APP_NAME)"

# ── Clean ───────────────────────────────────────────────────────────
clean:
	rm -rf .build $(APP_NAME)
