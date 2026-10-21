import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// One version for every platform: the one in the repository's package.json.
// Read through providers.fileContents, so the configuration cache sees a
// changed version.
val packageJson = providers.fileContents(rootProject.layout.projectDirectory.file("../package.json")).asText.get()
@Suppress("UNCHECKED_CAST")
val appVersion = (JsonSlurper().parseText(packageJson) as Map<String, Any>)["version"] as String
val versionParts = appVersion.split(".").map { part -> part.takeWhile { it.isDigit() }.toInt() }
require(versionParts.size == 3 && versionParts[1] < 100 && versionParts[2] < 100) { "unexpected version $appVersion" }

// hev-socks5-tunnel, fetched and checked by scripts/fetch-hev.js; checked
// again before every build (verifyHev below).
val hevDir = File(rootProject.projectDir, "third_party/hev-socks5-tunnel")
if (!File(hevDir, "Android.mk").isFile) {
    throw GradleException("hev-socks5-tunnel is missing: run `node android/scripts/fetch-hev.js` first")
}

val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")

// Two channels from one source, one package and one version code:
//  - the APK on GitHub (the default): signed with the app signing key, and
//    looks for updates on GitHub;
//  - the bundle for Google Play (-Pshroudly.store=play, with bundleRelease):
//    STORE_BUILD, so it never asks GitHub for updates, and signed with the
//    upload key; Play re-signs it with the same app signing key as the APK
//    (android/PLAY_STORE.md), so either install updates the other.
val playBuild = providers.gradleProperty("shroudly.store").orNull == "play"

// Release signing comes from the environment (CI); nothing secret is in the
// repository. ANDROID_* is the app signing key, ANDROID_UPLOAD_* the upload key.
val keyEnv = if (playBuild) "ANDROID_UPLOAD_" else "ANDROID_"
val keystorePath = providers.environmentVariable("${keyEnv}KEYSTORE").orNull
val releaseSigned = !keystorePath.isNullOrBlank()

android {
    namespace = "me.codeshare.shroudly"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "me.codeshare.shroudly"
        minSdk = 26
        targetSdk = 36
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = appVersion
        buildConfigField("boolean", "STORE_BUILD", playBuild.toString())

        ndk { abiFilters += abis }
        externalNativeBuild {
            ndkBuild {
                // The engine (core/src, run inside the app's process) and hev:
                // src/main/cpp/Android.mk.
                targets += listOf("shroudlycore_jni", "hev-socks5-tunnel")
                // The JNI class hev registers its natives on (see Tun2Socks.kt).
                cFlags += listOf("-DPKGNAME=me/codeshare/shroudly", "-DCLSNAME=Tun2Socks")
                arguments += listOf("APP_SUPPORT_FLEXIBLE_PAGE_SIZES=true")
            }
        }
    }

    externalNativeBuild {
        ndkBuild { path = file("src/main/cpp/Android.mk") }
    }

    signingConfigs {
        if (releaseSigned) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = providers.environmentVariable("${keyEnv}KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("${keyEnv}KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("${keyEnv}KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without the variables the release APK (or bundle) is left unsigned.
            if (releaseSigned) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }

    // The libraries stay compressed in the APK (a smaller download) and are
    // extracted at install, in the bundle's APKs too. Every lib*.so is linked
    // for 16 KB pages (scripts/check-16k.sh checks the APK and the bundle).
    // libshroudlycore.so was the engine as a program of its own (up to
    // 2.6.1, built into src/main/jniLibs by a script); one left there by an
    // old build is not packaged.
    packaging {
        jniLibs {
            useLegacyPackaging = true
            excludes += "lib/*/libshroudlycore.so"
        }
    }

    lint {
        // Translations come from locales/*.json and are checked there.
        disable += listOf("MissingTranslation", "ExtraTranslation")
        abortOnError = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

// The hev tree that is built must be the pinned one, file for file: a tree
// accepted with SHROUDLY_HEV_TRUST=1, edited, or restored from a cache stops
// the build. Hashing it takes well under a second.
val verifyHev = tasks.register<Exec>("verifyHev") {
    workingDir = rootProject.projectDir
    commandLine("node", "scripts/fetch-hev.js", "--verify")
}

tasks.configureEach {
    if (name == "preBuild" || name.startsWith("configureNdkBuild") || name.startsWith("buildNdkBuild")) dependsOn(verifyHev)
}
