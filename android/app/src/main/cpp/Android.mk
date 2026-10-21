# The app's native libraries, built by the Android Gradle plugin's ndk-build
# (app/build.gradle.kts):
#
#   libshroudlycore_jni.so  the engine, from core/src (the same sources the
#                           desktop builds), run inside the app's process
#                           (engine_jni.c, EngineNative.kt);
#   libhev-socks5-tunnel.so hev-socks5-tunnel, from third_party (fetched and
#                           checked by scripts/fetch-hev.js).
#
# Both are linked for 16 KB pages as well as 4 KB ones (Android 15+ devices;
# scripts/check-16k.sh checks the result).

SHROUDLY_CPP := $(call my-dir)
SHROUDLY_CORE := ../../../../../core/src

include $(CLEAR_VARS)
LOCAL_PATH := $(SHROUDLY_CPP)
LOCAL_MODULE := shroudlycore_jni
# Every engine source, as the desktop's scripts/build-core.js takes them: no
# Advanced (packet-layer) backend (no SHROUDLY_RAW), and main.c without its
# main() (SHROUDLY_NO_MAIN).
LOCAL_SRC_FILES := engine_jni.c \
    $(addprefix $(SHROUDLY_CORE)/,$(notdir $(sort $(wildcard $(LOCAL_PATH)/$(SHROUDLY_CORE)/*.c))))
LOCAL_C_INCLUDES := $(LOCAL_PATH)/$(SHROUDLY_CORE)
# -O2 in debug builds too: the techniques depend on timing, and the debug
# build is what the emulator tests run. Only the JNI entry point is exported
# (hidden visibility), so nothing of the engine can bind to a name in
# libhev-socks5-tunnel.so or the other way round.
LOCAL_CFLAGS := -std=c11 -O2 -Wall -Wextra -D_GNU_SOURCE -DSHROUDLY_NO_MAIN \
    -fvisibility=hidden -ffunction-sections -fdata-sections \
    -fstack-protector-strong -D_FORTIFY_SOURCE=2
LOCAL_LDFLAGS := -Wl,--gc-sections -Wl,-z,relro -Wl,-z,now \
    -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384
include $(BUILD_SHARED_LIBRARY)

include $(SHROUDLY_CPP)/../../../../third_party/hev-socks5-tunnel/Android.mk
