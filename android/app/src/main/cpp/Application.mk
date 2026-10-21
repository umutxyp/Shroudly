# ndk-build's application settings for Android.mk here: hev-socks5-tunnel's
# own (third_party/hev-socks5-tunnel/Application.mk), which it was built with
# when Android.mk was its own. The ABIs and the minimum API level come from
# app/build.gradle.kts.
APP_OPTIM := release
APP_CFLAGS := -O3
APP_SUPPORT_FLEXIBLE_PAGE_SIZES := true
NDK_TOOLCHAIN_VERSION := clang
