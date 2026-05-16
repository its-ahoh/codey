#ifndef WHISPER_BRIDGE_SHIM_H
#define WHISPER_BRIDGE_SHIM_H

// Re-export the whisper.cpp C API for Swift.
// whisper.h is a pure-C header (extern "C" guarded) and can be imported directly.
#include "whisper.h"

#endif
