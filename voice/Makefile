# Codey Voice — build whisper.cpp and the Swift helper
WHISPER_DIR := whisper.cpp
BUILD_DIR   := $(WHISPER_DIR)/build
DEPS_DIR    := .build/deps

.PHONY: all build-whisper setup-deps build run clean

all: build

# ── Build whisper.cpp via CMake ─────────────────────────────────────
build-whisper:
	@echo "[voice] Building whisper.cpp …"
	cmake -S $(WHISPER_DIR) -B $(BUILD_DIR) \
		-DCMAKE_BUILD_TYPE=Release \
		-DBUILD_SHARED_LIBS=OFF \
		-DWHISPER_BUILD_TESTS=OFF \
		-DWHISPER_BUILD_EXAMPLES=OFF \
		-DGGML_METAL=ON
	cmake --build $(BUILD_DIR) --config Release -j$$(sysctl -n hw.ncpu)

# ── Copy headers + libs into deps/ ──────────────────────────────────
setup-deps: build-whisper
	@echo "[voice] Collecting deps …"
	mkdir -p $(DEPS_DIR)/include $(DEPS_DIR)/lib
	# Headers for the system library module map
	cp -f $(WHISPER_DIR)/include/whisper.h           Sources/WhisperBridge/include/
	cp -f $(WHISPER_DIR)/ggml/include/ggml.h         Sources/WhisperBridge/include/
	cp -f $(WHISPER_DIR)/ggml/include/ggml-cpu.h     Sources/WhisperBridge/include/
	cp -f $(WHISPER_DIR)/ggml/include/ggml-alloc.h   Sources/WhisperBridge/include/
	cp -f $(WHISPER_DIR)/ggml/include/ggml-backend.h Sources/WhisperBridge/include/
	cp -f $(WHISPER_DIR)/ggml/include/ggml-metal.h   Sources/WhisperBridge/include/
	# Static libraries
	mkdir -p $(DEPS_DIR)/lib
	cp -f $(BUILD_DIR)/src/libwhisper.a               $(DEPS_DIR)/lib/ 2>/dev/null || true
	cp -f $(BUILD_DIR)/ggml/src/libggml.a             $(DEPS_DIR)/lib/ 2>/dev/null || true
	cp -f $(BUILD_DIR)/ggml/src/libggml-cpu.a         $(DEPS_DIR)/lib/ 2>/dev/null || true
	cp -f $(BUILD_DIR)/ggml/src/libggml-base.a        $(DEPS_DIR)/lib/ 2>/dev/null || true
	cp -f $(BUILD_DIR)/ggml/src/ggml-metal/libggml-metal.a $(DEPS_DIR)/lib/ 2>/dev/null || true
	@echo "[voice] Done. Deps in $(DEPS_DIR)/"

# ── Swift build ─────────────────────────────────────────────────────
build: setup-deps
	swift build -c release

# ── Run ─────────────────────────────────────────────────────────────
run: build
	@.build/release/CodeyVoice

# ── Download tiny model ─────────────────────────────────────────────
MODEL_URL := https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin

download-model:
	@mkdir -p $(HOME)/.codey/models
	@if [ ! -f $(HOME)/.codey/models/ggml-tiny.bin ]; then \
		echo "[voice] Downloading ggml-tiny.bin …"; \
		curl -L -o $(HOME)/.codey/models/ggml-tiny.bin $(MODEL_URL); \
	else \
		echo "[voice] Model already exists."; \
	fi

# ── Clean ───────────────────────────────────────────────────────────
clean:
	rm -rf $(BUILD_DIR) $(DEPS_DIR) .build Sources/WhisperBridge/include/*.h
